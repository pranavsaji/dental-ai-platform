"""Billing / revenue-cycle agent: prioritize aging insurance claims and draft
the follow-up communication for the worst one. Two-node LangGraph
(prioritize -> draft), same fallback contract as the scheduling agent.
"""

from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from .config import llm_available
from .llm import invoke_structured


class AgingClaim(BaseModel):
    claimSourceId: int
    patientName: str
    carrierName: str
    dateService: str | None = None
    dateSent: str | None = None
    claimFee: float
    insPayEst: float
    daysOutstanding: int


class ReviewRequest(BaseModel):
    locationName: str
    claims: list[AgingClaim]


class ReviewResponse(BaseModel):
    claimSourceId: int
    rationale: str
    letter: str
    usedLlm: bool


class _Priority(BaseModel):
    claim_source_id: int = Field(description="claimSourceId of the claim to chase first")
    rationale: str = Field(
        description="One or two sentences: why this claim first (age, value, payer patterns)"
    )


class _Letter(BaseModel):
    letter: str = Field(description="The claim-status follow-up message to the carrier")


class _State(TypedDict):
    request: ReviewRequest
    priority: _Priority
    letter: _Letter


def _prioritize(state: _State) -> dict:
    req = state["request"]
    lines = "\n".join(
        f"- claimSourceId={c.claimSourceId} | {c.carrierName} | patient {c.patientName} | "
        f"billed ${c.claimFee:.0f} (est. ${c.insPayEst:.0f}) | sent {c.dateSent} | "
        f"{c.daysOutstanding} days outstanding"
        for c in req.claims
    )
    result = invoke_structured(_Priority, [
        SystemMessage(content=(
            "You are the revenue-cycle agent for a dental group. Pick which outstanding "
            "insurance claim to follow up first. Weigh days outstanding (30+ needs action, "
            "60+ is urgent), dollar value, and expected insurance payment. Pick from the list."
        )),
        HumanMessage(content=f"Practice: {req.locationName}\nOpen claims:\n{lines}"),
    ])
    return {"priority": result}


def _draft(state: _State) -> dict:
    req = state["request"]
    claim = next(
        c for c in req.claims if c.claimSourceId == state["priority"].claim_source_id
    )
    result = invoke_structured(_Letter, [
        SystemMessage(content=(
            "Draft a concise, professional claim-status inquiry a dental billing coordinator "
            "would send to an insurance carrier. Reference date of service and days elapsed, "
            "request status and expected payment date, and note follow-up will continue "
            "until adjudicated. Do not invent claim numbers, member IDs, or policy details "
            "beyond those provided. Under 150 words."
        )),
        HumanMessage(content=(
            f"Carrier: {claim.carrierName}\nPatient: {claim.patientName}\n"
            f"Date of service: {claim.dateService}\nClaim sent: {claim.dateSent} "
            f"({claim.daysOutstanding} days ago)\nBilled: ${claim.claimFee:.2f}, "
            f"expected insurance payment: ${claim.insPayEst:.2f}\nPractice: {req.locationName}"
        )),
    ])
    return {"letter": result}


_graph = None


def _fallback(req: ReviewRequest) -> ReviewResponse:
    worst = max(req.claims, key=lambda c: (c.daysOutstanding, c.claimFee))
    return ReviewResponse(
        claimSourceId=worst.claimSourceId,
        rationale=(
            f"Deterministic fallback: oldest/highest-value claim "
            f"({worst.daysOutstanding} days, ${worst.claimFee:.0f})."
        ),
        letter=(
            f"To {worst.carrierName}: We are following up on the claim for {worst.patientName}, "
            f"date of service {worst.dateService}, submitted {worst.dateSent} "
            f"({worst.daysOutstanding} days ago; billed ${worst.claimFee:.2f}). Please provide "
            "the current adjudication status and expected payment date. We will continue to "
            f"follow up until this claim is resolved. — {req.locationName} billing office"
        ),
        usedLlm=False,
    )


def review(req: ReviewRequest) -> ReviewResponse:
    if not req.claims:
        raise ValueError("no claims")
    if not llm_available():
        return _fallback(req)

    global _graph
    if _graph is None:
        g = StateGraph(_State)
        g.add_node("prioritize", _prioritize)
        g.add_node("draft", _draft)
        g.add_edge(START, "prioritize")
        g.add_edge("prioritize", "draft")
        g.add_edge("draft", END)
        _graph = g.compile()
    try:
        out = _graph.invoke({"request": req})
        return ReviewResponse(
            claimSourceId=out["priority"].claim_source_id,
            rationale=out["priority"].rationale,
            letter=out["letter"].letter,
            usedLlm=True,
        )
    except Exception as exc:
        resp = _fallback(req)
        resp.rationale += f" (agent error: {type(exc).__name__})"
        return resp
