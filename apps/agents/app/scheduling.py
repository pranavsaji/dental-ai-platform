"""Scheduling agent: given an opened slot and overdue-recall candidates,
pick the best patient to offer it to and draft the outreach SMS.

Built as a small LangGraph state machine (rank -> draft) so the shape scales
to the larger scheduling graphs (waitlist sweeps, recall campaigns) without
changing the service contract. LLM calls go through the provider chain
(DeepSeek primary, Anthropic fallback) and fall back to a deterministic
template when no key is configured, so the demo runs end-to-end regardless.
"""

from typing import TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from .config import llm_available
from .deid import Deidentifier
from .llm import invoke_structured


class Candidate(BaseModel):
    patientSourceId: int
    name: str
    phone: str
    overdueSince: str | None = None
    lastVisit: str | None = None
    # C4: chronic no-shows should not get first crack at an open slot.
    priorNoShows: int = 0


class Slot(BaseModel):
    startsAt: str
    minutes: int
    procDescript: str


class ProposeRequest(BaseModel):
    locationName: str
    slot: Slot
    cancelledPatientName: str
    candidates: list[Candidate]


class ProposeResponse(BaseModel):
    patientSourceId: int
    message: str
    rationale: str
    usedLlm: bool


class _Ranking(BaseModel):
    """Structured output for the ranking step."""
    patient_source_id: int = Field(description="patientSourceId of the best candidate")
    rationale: str = Field(description="One sentence on why this patient is the best fit")


class _Draft(BaseModel):
    """Structured output for the drafting step."""
    message: str = Field(description="The SMS text to send the patient")


class _State(TypedDict):
    request: ProposeRequest
    # One Deidentifier per request so rank + draft share the same token map.
    deid: Deidentifier
    chosen: _Ranking
    draft: _Draft


def _rank_node(state: _State) -> dict:
    req = state["request"]
    lines = "\n".join(
        f"- patientSourceId={c.patientSourceId} | {c.name} | overdue since {c.overdueSince} | "
        f"last visit {c.lastVisit} | prior no-shows {c.priorNoShows}"
        for c in req.candidates
    )
    result = invoke_structured(_Ranking, [
        SystemMessage(content=(
            "You are the scheduling agent for a dental group. A chair opened up due to a "
            "cancellation. Pick the single best patient to offer the slot to. Prefer the "
            "most overdue recall, but use judgment (a patient overdue for years is likely "
            "lapsed; 6-18 months overdue converts best). Deprioritize patients with 2+ "
            "prior no-shows — they burn the slot. You must pick from the list."
        )),
        HumanMessage(content=(
            f"Open slot: {req.slot.startsAt} ({req.slot.minutes} min, {req.slot.procDescript}) "
            f"at {req.locationName}.\nCandidates:\n{lines}"
        )),
    ], deid=state["deid"])
    return {"chosen": result}


def _draft_node(state: _State) -> dict:
    req = state["request"]
    chosen = next(
        c for c in req.candidates if c.patientSourceId == state["chosen"].patient_source_id
    )
    result = invoke_structured(_Draft, [
        SystemMessage(content=(
            "Draft a short, warm SMS from a dental office offering a just-opened appointment "
            "slot. Requirements: greet the patient by first name, name the practice, give the "
            "day/date/time in plain words, mention they're due for a visit, ask them to reply "
            "YES to book or NO to pass. Under 320 characters. No emojis. Do not invent "
            "clinical details."
        )),
        HumanMessage(content=(
            f"Practice: {req.locationName}\nPatient: {chosen.name}\n"
            f"Slot: {req.slot.startsAt} ({req.slot.minutes} minutes)\n"
            f"Patient overdue for hygiene recall since {chosen.overdueSince}."
        )),
    ], deid=state["deid"])
    return {"draft": result}


def _build_graph():
    g = StateGraph(_State)
    g.add_node("rank", _rank_node)
    g.add_node("draft", _draft_node)
    g.add_edge(START, "rank")
    g.add_edge("rank", "draft")
    g.add_edge("draft", END)
    return g.compile()


_graph = None


def _fallback(req: ProposeRequest) -> ProposeResponse:
    chosen = req.candidates[0]
    first = chosen.name.split(" ")[0]
    return ProposeResponse(
        patientSourceId=chosen.patientSourceId,
        message=(
            f"Hi {first}, this is {req.locationName}. An appointment just opened up on "
            f"{req.slot.startsAt.replace('T', ' at ')} and you're due for a visit. "
            "Would you like it? Reply YES to book or NO to pass."
        ),
        rationale="Deterministic fallback: most-overdue reachable candidate (no LLM key configured).",
        usedLlm=False,
    )


# --- C5: unscheduled-treatment outreach -----------------------------------------
# The platform ranks the backlog deterministically (fee × plan age); the agent
# refines the order with conversion judgment and drafts the messages. Same
# contract as everything else: template fallback, the LLM never gates the demo.


class OutreachCandidate(BaseModel):
    patientSourceId: int
    name: str
    procCode: str
    description: str
    fee: float
    ageDays: int


class OutreachRequest(BaseModel):
    locationName: str
    batchSize: int
    candidates: list[OutreachCandidate]


class OutreachPick(BaseModel):
    patientSourceId: int
    message: str


class OutreachResponse(BaseModel):
    picks: list[OutreachPick]
    rationale: str
    usedLlm: bool


class _OutreachPlan(BaseModel):
    picks: list[OutreachPick] = Field(
        description="The patients to text, best conversion odds first, each with its SMS text"
    )
    rationale: str = Field(description="One or two sentences on the ordering")


def _outreach_template(location_name: str, c: OutreachCandidate) -> str:
    weeks = max(1, round(c.ageDays / 7))
    return (
        f"Hi {c.name.split(' ')[0]}, this is {location_name}. Dr.'s notes show your "
        f"{c.description.lower()} from {weeks} weeks ago is still waiting to be scheduled. "
        "Reply YES and we'll text you a few times that work, or call us anytime."
    )


def _outreach_fallback(req: OutreachRequest) -> OutreachResponse:
    picks = [
        OutreachPick(
            patientSourceId=c.patientSourceId,
            message=_outreach_template(req.locationName, c),
        )
        for c in req.candidates[: req.batchSize]
    ]
    return OutreachResponse(
        picks=picks,
        rationale="Deterministic ranking: fee × plan age.",
        usedLlm=False,
    )


def outreach(req: OutreachRequest) -> OutreachResponse:
    if not req.candidates:
        raise ValueError("no candidates")
    if not llm_available():
        return _outreach_fallback(req)
    try:
        deid = Deidentifier()
        for c in req.candidates:
            deid.register_person(c.name)
        lines = "\n".join(
            f"- patientSourceId={c.patientSourceId} | {c.name} | {c.description} ({c.procCode}) | "
            f"${c.fee:.0f} | planned {c.ageDays} days ago"
            for c in req.candidates
        )
        result = invoke_structured(_OutreachPlan, [
            SystemMessage(content=(
                f"You are the scheduling agent for a dental group. Pick up to {req.batchSize} "
                "patients with planned-but-unscheduled treatment to text today, ordered by "
                "conversion odds (recent-ish plans and higher-value treatment convert best; "
                "plans older than a year are likely lapsed). Pick only from the list. For each, "
                "draft a short, warm SMS: greet by first name, name the practice, reference the "
                "planned treatment in plain words, ask them to reply YES to get scheduling "
                "options. Under 320 characters, no emojis, no invented clinical details."
            )),
            HumanMessage(content=f"Practice: {req.locationName}\nBacklog:\n{lines}"),
        ], deid=deid)
        valid = [
            p for p in result.picks
            if any(c.patientSourceId == p.patientSourceId for c in req.candidates) and p.message.strip()
        ]
        if not valid:
            return _outreach_fallback(req)
        return OutreachResponse(picks=valid[: req.batchSize], rationale=result.rationale, usedLlm=True)
    except Exception as exc:
        resp = _outreach_fallback(req)
        resp.rationale += f" (agent error: {type(exc).__name__})"
        return resp


def propose(req: ProposeRequest) -> ProposeResponse:
    if not req.candidates:
        raise ValueError("no candidates")
    if not llm_available():
        return _fallback(req)

    global _graph
    if _graph is None:
        _graph = _build_graph()
    try:
        deid = Deidentifier()
        deid.register_person(req.cancelledPatientName)
        for c in req.candidates:
            deid.register_person(c.name)
            deid.register_person(c.phone, kind="PHONE")
        out = _graph.invoke({"request": req, "deid": deid})
        return ProposeResponse(
            patientSourceId=out["chosen"].patient_source_id,
            message=out["draft"].message,
            rationale=out["chosen"].rationale,
            usedLlm=True,
        )
    except Exception as exc:  # LLM/API failure must never stall the workflow
        resp = _fallback(req)
        resp.rationale += f" (agent error: {type(exc).__name__})"
        return resp
