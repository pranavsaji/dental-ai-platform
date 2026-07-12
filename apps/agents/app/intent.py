"""Inbound intent router agent (E2): classify a patient text that no live
workflow claimed, and draft a suggested reply for staff review. This is NOT a
chatbot — the reply is never sent autonomously; it prefills the reply box on a
patient_question task and always crosses the human gate.

Grounding discipline: the draft may cite ONLY the provided context (next
appointment, last visit date, insurance-pending amount). Anything the context
cannot answer gets a polite "the front desk will follow up" — never a guess,
never clinical advice, never a promised price or balance the data doesn't
show. No-LLM fallback classifies everything as `other` with a safe
acknowledgement template.
"""

from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from .config import llm_available
from .deid import Deidentifier
from .llm import invoke_structured

Intent = Literal["question", "billing_question", "reschedule", "confirm", "other"]


class IntentRequest(BaseModel):
    message: str
    patientName: str
    locationName: str
    nextAppointment: str | None = None
    lastVisit: str | None = None
    # Insurance-pending estimate (open claim fees minus insurance payments) —
    # an approximation, and the prompt says to present it as one.
    openClaimsValue: float = 0


class IntentResponse(BaseModel):
    intent: Intent
    suggestedReply: str
    usedLlm: bool


class _Classified(BaseModel):
    intent: Intent = Field(
        description=(
            "question = general/clinical question; billing_question = money, "
            "balance, insurance, statements; reschedule = wants to move/cancel "
            "an appointment; confirm = confirming an appointment; other = "
            "anything else (greetings, wrong number, unclear)."
        )
    )
    suggestedReply: str = Field(
        description=(
            "Suggested SMS reply for staff to review, under 300 characters, "
            "plain text, warm but professional. Cite ONLY facts from the "
            "context. If the context cannot answer, say the front desk will "
            "follow up. Never give clinical advice or invent amounts/dates."
        )
    )


def _fallback(req: IntentRequest) -> IntentResponse:
    first = req.patientName.split(" ")[0] if req.patientName else "there"
    return IntentResponse(
        intent="other",
        suggestedReply=(
            f"Hi {first}, thanks for your message — this is {req.locationName}. "
            "A member of our front desk team will get back to you shortly. "
            "If it's urgent, please call us."
        ),
        usedLlm=False,
    )


def classify_intent(req: IntentRequest) -> IntentResponse:
    if not llm_available():
        return _fallback(req)
    try:
        deid = Deidentifier()
        deid.register_person(req.patientName)
        result = invoke_structured(_Classified, [
            SystemMessage(content=(
                "You triage inbound SMS for a dental practice front desk. "
                "Classify the patient's message into exactly one intent and "
                "draft a suggested reply a staff member will review before "
                "sending — you are drafting for a human gate, not replying "
                "yourself. Ground every fact in the provided context fields "
                "(nextAppointment, lastVisit, openClaimsValue — an estimate of "
                "insurance still being processed, phrase it as an estimate). "
                "If the context does not answer the question, the reply should "
                "say the front desk will check and follow up. Under 300 "
                "characters, plain text, no markdown, no clinical advice, "
                "never invent balances, prices, dates, or availability."
            )),
            HumanMessage(content=req.model_dump_json()),
        ], deid=deid)
        reply = (result.suggestedReply or "").strip()
        if not reply:
            return _fallback(req)
        return IntentResponse(intent=result.intent, suggestedReply=reply[:300], usedLlm=True)
    except Exception:
        return _fallback(req)
