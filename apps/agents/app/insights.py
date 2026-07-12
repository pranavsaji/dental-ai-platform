"""Owner insights agent (D3): answer "why did site B underperform this week?"
from metric deltas, not vibes. Single-node compare → narrate. The comparison
windows arrive pre-computed (per location, per metric: window averages,
previous std, delta %, z-score) from daily_location_metrics — small structured
JSON, no RAG. Grounding discipline: every claim must cite metric names and
values from the payload; "not in the data" is a valid answer; correlations are
phrased as observations, never invented causes. Deterministic fallback =
top-3 largest |z| deltas rendered by template.
"""

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from .config import llm_available
from .deid import Deidentifier
from .llm import invoke_structured


class MetricDelta(BaseModel):
    metric: str
    currentAvg: float
    previousAvg: float
    previousStd: float
    deltaPct: float | None = None
    zScore: float | None = None


class LocationDeltas(BaseModel):
    locationId: int
    key: str
    name: str
    metrics: list[MetricDelta]


class InsightsRequest(BaseModel):
    question: str
    windowDays: int
    currentRange: str
    previousRange: str
    locations: list[LocationDeltas]


class InsightsResponse(BaseModel):
    answer: str
    highlights: list[str]
    usedLlm: bool


class _Insight(BaseModel):
    answer: str = Field(
        description=(
            "Answer to the owner's question, grounded ONLY in the metric payload. "
            "Cite metric names and values for every claim. Plain prose, no markdown."
        )
    )
    highlights: list[str] = Field(
        description="Up to 5 one-line metric citations backing the answer, e.g. "
        "'Round Rock: collections averaged 5100/day vs 6900/day prior (-26%, z -2.4)'"
    )


def _fallback(req: InsightsRequest) -> InsightsResponse:
    deltas = [
        (loc.name, m)
        for loc in req.locations
        for m in loc.metrics
        if m.zScore is not None
    ]
    deltas.sort(key=lambda t: abs(t[1].zScore or 0), reverse=True)
    top = deltas[:3]
    highlights = [
        f"{name}: {m.metric} averaged {m.currentAvg}/day ({req.currentRange}) vs "
        f"{m.previousAvg}/day ({req.previousRange})"
        + (f", {'+' if (m.deltaPct or 0) > 0 else ''}{m.deltaPct}%" if m.deltaPct is not None else "")
        + f" (z {m.zScore})"
        for name, m in top
    ]
    if not top:
        answer = (
            "No metric moved meaningfully between the two windows — nothing in the "
            "data explains a change in performance."
        )
    else:
        answer = (
            "Largest week-over-week changes in the metrics data: "
            + "; ".join(highlights)
            + ". These are observations from daily_location_metrics only — anything "
            "beyond these numbers is not in the data."
        )
    return InsightsResponse(answer=answer, highlights=highlights, usedLlm=False)


def draft_insights(req: InsightsRequest) -> InsightsResponse:
    if not llm_available():
        return _fallback(req)
    try:
        # G5: the payload is location metrics (no patient identifiers), but
        # every LLM call goes through the scrubber — the invariant holds
        # without a documented exception; pattern classes (phones/emails in
        # the owner's free-text question) are still caught.
        deid = Deidentifier()
        result = invoke_structured(_Insight, [
            SystemMessage(content=(
                "You are the owner-insights agent for a multi-location dental group. "
                "You receive two comparison windows of daily location metrics (current "
                "vs previous averages, previous std, delta %, z-score per metric per "
                "location) and the owner's question. Answer ONLY from that payload: "
                "cite the metric name and both window values for every claim you make. "
                "If the payload cannot answer the question, say exactly what is not in "
                "the data — never guess or invent causes. Phrase any relationship "
                "between metrics as an observed correlation, not a cause. Plain prose, "
                "no markdown, under 180 words. Then list up to 5 one-line metric "
                "citations (location, metric, both averages, delta, z) that back the "
                "answer. Larger |z| means a more unusual move."
            )),
            HumanMessage(content=req.model_dump_json()),
        ], deid=deid)
        return InsightsResponse(
            answer=result.answer, highlights=result.highlights[:5], usedLlm=True
        )
    except Exception:
        return _fallback(req)
