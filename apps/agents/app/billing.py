"""Billing / revenue-cycle agent: prioritize aging insurance claims and draft
the follow-up communication for the worst one. Two-node LangGraph
(prioritize -> draft), same fallback contract as the scheduling agent.
"""

from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from .config import llm_available
from .deid import Deidentifier
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
    # One Deidentifier per request so prioritize + draft share the token map.
    deid: Deidentifier
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
    ], deid=state["deid"])
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
    ], deid=state["deid"])
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


# --- Phase B billing surfaces -------------------------------------------------
# Each follows the platform contract: deterministic template fallback when no
# LLM is configured (or the call fails), and the LLM refines within — never
# contradicts — the structured facts it is given.


class EligibilitySummaryRequest(BaseModel):
    patientName: str
    carrierName: str
    status: str  # verified | inactive | attention | failed
    deductibleRemaining: float
    annualMax: float
    annualMaxUsed: float
    frequencyFlags: list[str] = []
    payerNote: str = ""


class EligibilitySummaryResponse(BaseModel):
    summary: str
    usedLlm: bool


class _Summary(BaseModel):
    summary: str = Field(description="One or two sentences for the front desk / billing team")


def _eligibility_fallback(req: EligibilitySummaryRequest) -> EligibilitySummaryResponse:
    parts: list[str] = []
    if req.status == "inactive":
        parts.append(f"{req.carrierName} reports coverage inactive for {req.patientName}.")
    elif req.status == "failed":
        parts.append(f"Eligibility could not be verified with {req.carrierName} (payer unavailable after retries).")
    else:
        remaining = max(0.0, req.annualMax - req.annualMaxUsed)
        parts.append(
            f"{req.carrierName} coverage active for {req.patientName}. "
            f"${remaining:.0f} of ${req.annualMax:.0f} annual max remaining; "
            f"deductible remaining ${req.deductibleRemaining:.0f}."
        )
    if req.frequencyFlags:
        parts.append("Limitations: " + "; ".join(req.frequencyFlags) + ".")
    if req.payerNote:
        parts.append(req.payerNote)
    return EligibilitySummaryResponse(summary=" ".join(parts), usedLlm=False)


def summarize_eligibility(req: EligibilitySummaryRequest) -> EligibilitySummaryResponse:
    if not llm_available():
        return _eligibility_fallback(req)
    try:
        deid = Deidentifier()
        deid.register_person(req.patientName)
        result = invoke_structured(_Summary, [
            SystemMessage(content=(
                "Summarize a dental insurance eligibility response for the front desk in one or "
                "two sentences. State only the facts provided — never invent coverage amounts, "
                "dates, or plan details. Flag anything the team must act on (inactive coverage, "
                "exhausted allowances, unmet deductible)."
            )),
            HumanMessage(content=req.model_dump_json()),
        ], deid=deid)
        return EligibilitySummaryResponse(summary=result.summary, usedLlm=True)
    except Exception:
        return _eligibility_fallback(req)


class NoteRef(BaseModel):
    id: int
    note: str


class PreauthDraftRequest(BaseModel):
    locationName: str
    patientName: str
    carrierName: str
    procCode: str
    description: str
    toothNum: str = ""
    fee: float
    notes: list[NoteRef] = []


class PreauthDraftResponse(BaseModel):
    narrative: str
    usedLlm: bool


class _Narrative(BaseModel):
    narrative: str = Field(description="The clinical narrative for the pre-authorization request")


def _preauth_fallback(req: PreauthDraftRequest) -> PreauthDraftResponse:
    tooth = f", tooth {req.toothNum}" if req.toothNum else ""
    cites = f" (notes {', '.join(str(n.id) for n in req.notes)})" if req.notes else ""
    return PreauthDraftResponse(
        narrative=(
            f"Pre-authorization request to {req.carrierName} for {req.patientName}: "
            f"{req.description} ({req.procCode}{tooth}), planned fee ${req.fee:.2f}. "
            f"Treatment is clinically indicated per the attached chart documentation{cites}. "
            f"Radiographs and clinical notes available on request. — {req.locationName} billing office"
        ),
        usedLlm=False,
    )


def draft_preauth(req: PreauthDraftRequest) -> PreauthDraftResponse:
    if not llm_available():
        return _preauth_fallback(req)
    try:
        deid = Deidentifier()
        deid.register_person(req.patientName)
        notes = "\n".join(f"[note {n.id}] {n.note}" for n in req.notes) or "(no chart notes provided)"
        result = invoke_structured(_Narrative, [
            SystemMessage(content=(
                "Draft a concise clinical narrative for a dental pre-authorization request. "
                "Ground every clinical claim in the provided chart notes, citing them as "
                "[note <id>]. Do not invent findings, radiographs, dates, or identifiers not "
                "present in the input. Under 150 words, professional payer-facing tone."
            )),
            HumanMessage(content=(
                f"Practice: {req.locationName}\nCarrier: {req.carrierName}\n"
                f"Patient: {req.patientName}\nProcedure: {req.description} "
                f"({req.procCode}{', tooth ' + req.toothNum if req.toothNum else ''}), fee ${req.fee:.2f}\n"
                f"Chart notes:\n{notes}"
            )),
        ], deid=deid)
        return PreauthDraftResponse(narrative=result.narrative, usedLlm=True)
    except Exception:
        return _preauth_fallback(req)


class AppealDraftRequest(BaseModel):
    locationName: str
    patientName: str
    carrierName: str
    claimSourceId: int
    dateService: str | None = None
    claimFee: float
    carcCodes: list[str]
    category: str  # fixed by the deterministic CARC map — the LLM may not change it
    carcDescriptions: list[str] = []


class AppealDraftResponse(BaseModel):
    summary: str
    letter: str
    usedLlm: bool


class _Appeal(BaseModel):
    summary: str = Field(description="One-sentence denial summary for the worklist")
    letter: str = Field(description="The appeal letter to the carrier")


def _appeal_fallback(req: AppealDraftRequest) -> AppealDraftResponse:
    category = req.category.replace("_", " ")
    reasons = "; ".join(req.carcDescriptions) or f"CARC {', '.join(req.carcCodes)}"
    return AppealDraftResponse(
        summary=f"Denied by {req.carrierName} ({category}): {reasons}.",
        letter=(
            f"To {req.carrierName} Appeals Department:\n\n"
            f"We formally appeal the denial of the claim for {req.patientName}, date of service "
            f"{req.dateService or 'on file'}, billed ${req.claimFee:.2f}, denied under "
            f"CARC {', '.join(req.carcCodes)} ({category}). The treatment was clinically necessary "
            f"and properly documented in the patient chart; supporting documentation is enclosed. "
            f"We request reprocessing of this claim and payment per plan benefits. Please respond "
            f"within 30 days.\n\n— {req.locationName} billing office"
        ),
        usedLlm=False,
    )


def draft_appeal(req: AppealDraftRequest) -> AppealDraftResponse:
    if not llm_available():
        return _appeal_fallback(req)
    try:
        deid = Deidentifier()
        deid.register_person(req.patientName)
        result = invoke_structured(_Appeal, [
            SystemMessage(content=(
                "Draft a dental claim appeal. The denial category was determined by a "
                f"deterministic CARC-code map and is '{req.category}' — you may refine language "
                "within that category but must not recharacterize the denial. Reference only the "
                "claim facts provided; never invent claim numbers, member IDs, dates, or clinical "
                "findings. Letter under 200 words, professional tone, requesting reprocessing."
            )),
            HumanMessage(content=req.model_dump_json()),
        ], deid=deid)
        return AppealDraftResponse(summary=result.summary, letter=result.letter, usedLlm=True)
    except Exception:
        return _appeal_fallback(req)


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
        deid = Deidentifier()
        for c in req.claims:
            deid.register_person(c.patientName)
        out = _graph.invoke({"request": req, "deid": deid})
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
