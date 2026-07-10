"""Morning huddle agent (C1): turn the day's structured facts into a ≤200-word
narrative plus a ranked action list. Single-node — the gathering is done
deterministically platform-side, so the agent's only job is narration and
prioritization over exactly that payload (grounding discipline: it may not
introduce numbers that aren't in the data). Deterministic sectioned-template
fallback when no LLM is configured.
"""

from typing import Any, Literal

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from .config import llm_available
from .llm import invoke_structured


class HuddleRequest(BaseModel):
    locationName: str
    date: str
    data: dict[str, Any]


class HuddleAction(BaseModel):
    title: str
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    taskType: str = "huddle_action"


class HuddleResponse(BaseModel):
    narrative: str
    actions: list[HuddleAction]
    usedLlm: bool


class _Digest(BaseModel):
    narrative: str = Field(
        description="The huddle narrative, under 200 words, plain prose for the front desk"
    )
    actions: list[HuddleAction] = Field(
        description="Ranked action items (most important first), max 5"
    )


def _fallback(req: HuddleRequest) -> HuddleResponse:
    d = req.data
    sched = d.get("schedule", {})
    claims = d.get("claims", {})
    unsched = d.get("unscheduledTreatment", {})
    yesterday = d.get("yesterday", {})
    tasks = d.get("tasks", {})
    high_risk = sched.get("highRisk", [])

    parts: list[str] = []
    first = f" starting {sched.get('firstStart')}" if sched.get("firstStart") else ""
    parts.append(
        f"{sched.get('appointments', 0)} appointments today{first}; "
        f"{sched.get('unconfirmed', 0)} unconfirmed and about "
        f"{round(sched.get('openChairMinutes', 0) / 60)}h of open chair time."
    )
    if high_risk:
        names = ", ".join(f"{r['patientName']} at {r['startsAt']}" for r in high_risk)
        parts.append(f"No-show risk: {names} — double-confirm by phone.")
    if d.get("eligibilityGaps", 0) > 0:
        parts.append(f"{d['eligibilityGaps']} of today's patients lack a green insurance check.")
    parts.append(
        f"Unscheduled treatment backlog: {unsched.get('count', 0)} plans worth ${unsched.get('value', 0)}."
    )
    billing = f"Billing: {claims.get('open', 0)} open claims (${claims.get('openValue', 0)})"
    if claims.get("openDenials", 0) > 0:
        billing += f", {claims['openDenials']} unresolved denials"
    if claims.get("preauthsNeedingInfo", 0) > 0:
        billing += f", {claims['preauthsNeedingInfo']} pre-auths waiting on documents"
    parts.append(billing + ".")
    urgent = f" ({tasks['urgent']} urgent)" if tasks.get("urgent", 0) > 0 else ""
    parts.append(
        f"Yesterday: ${yesterday.get('production', 0)} produced, "
        f"${yesterday.get('collections', 0)} collected. {tasks.get('open', 0)} open tasks{urgent}."
    )

    actions: list[HuddleAction] = []
    for r in high_risk:
        actions.append(HuddleAction(
            title=f"Call to double-confirm {r['patientName']} ({r['startsAt']}, risk {round(r['risk'] * 100)}%)",
            priority="high",
        ))
    if sched.get("unconfirmed", 0) > 0:
        actions.append(HuddleAction(
            title=f"Run the reminder sweep — {sched['unconfirmed']} of today's schedule unconfirmed"
        ))
    if d.get("eligibilityGaps", 0) > 0:
        actions.append(HuddleAction(
            title=f"Verify insurance for {d['eligibilityGaps']} of today's patients", priority="high"
        ))
    if unsched.get("count", 0) > 0:
        actions.append(HuddleAction(
            title=f"Run treatment outreach — ${unsched.get('value', 0)} unscheduled"
        ))
    if claims.get("openDenials", 0) > 0:
        actions.append(HuddleAction(
            title=f"Work {claims['openDenials']} unresolved denials in Billing", priority="high"
        ))
    return HuddleResponse(narrative=" ".join(parts), actions=actions[:5], usedLlm=False)


def draft_huddle(req: HuddleRequest) -> HuddleResponse:
    if not llm_available():
        return _fallback(req)
    try:
        result = invoke_structured(_Digest, [
            SystemMessage(content=(
                "You are the morning-huddle agent for a dental practice. Turn the structured "
                "facts into a crisp narrative (under 200 words) the office manager reads aloud "
                "at 7am: today's schedule and risks first, then insurance/billing exceptions, "
                "then yesterday's numbers. Plain prose only — no markdown, no asterisks, no "
                "headings. Every number you state must come from the data — "
                "never invent or extrapolate. Then rank up to 5 concrete action items, most "
                "important first, each phrased as something a specific ROLE (front desk, "
                "billing, hygiene, doctor, office manager) can do today. Never invent staff "
                "or patient names — only names present in the data may appear."
            )),
            HumanMessage(content=req.model_dump_json()),
        ])
        return HuddleResponse(narrative=result.narrative, actions=result.actions[:5], usedLlm=True)
    except Exception:
        return _fallback(req)
