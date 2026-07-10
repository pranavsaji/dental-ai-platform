from fastapi import FastAPI, HTTPException

from .billing import (
    AppealDraftRequest, AppealDraftResponse, EligibilitySummaryRequest,
    EligibilitySummaryResponse, PreauthDraftRequest, PreauthDraftResponse,
    ReviewRequest, ReviewResponse, draft_appeal, draft_preauth, review,
    summarize_eligibility,
)
from .clinical import (
    PrevisitRequest, PrevisitResponse, SearchRequest, embed_pending, previsit, search,
)
from .config import MODEL, llm_available, provider_chain
from .huddle import HuddleRequest, HuddleResponse, draft_huddle
from .insights import InsightsRequest, InsightsResponse, draft_insights
from .scheduling import (
    OutreachRequest, OutreachResponse, ProposeRequest, ProposeResponse, outreach, propose,
)

app = FastAPI(title="Dental AI Agents", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL, "llm": llm_available(), "providers": provider_chain()}


@app.post("/scheduling/propose", response_model=ProposeResponse)
def scheduling_propose(req: ProposeRequest) -> ProposeResponse:
    try:
        return propose(req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/scheduling/outreach", response_model=OutreachResponse)
def scheduling_outreach(req: OutreachRequest) -> OutreachResponse:
    try:
        return outreach(req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/ops/huddle", response_model=HuddleResponse)
def ops_huddle(req: HuddleRequest) -> HuddleResponse:
    return draft_huddle(req)


@app.post("/ops/insights", response_model=InsightsResponse)
def ops_insights(req: InsightsRequest) -> InsightsResponse:
    return draft_insights(req)


@app.post("/billing/review", response_model=ReviewResponse)
def billing_review(req: ReviewRequest) -> ReviewResponse:
    try:
        return review(req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/billing/eligibility-summary", response_model=EligibilitySummaryResponse)
def billing_eligibility_summary(req: EligibilitySummaryRequest) -> EligibilitySummaryResponse:
    return summarize_eligibility(req)


@app.post("/billing/preauth-draft", response_model=PreauthDraftResponse)
def billing_preauth_draft(req: PreauthDraftRequest) -> PreauthDraftResponse:
    return draft_preauth(req)


@app.post("/billing/appeal-draft", response_model=AppealDraftResponse)
def billing_appeal_draft(req: AppealDraftRequest) -> AppealDraftResponse:
    return draft_appeal(req)


@app.post("/clinical/embed")
def clinical_embed(locationId: int | None = None) -> dict:
    return embed_pending(locationId)


@app.post("/clinical/previsit", response_model=PrevisitResponse)
def clinical_previsit(req: PrevisitRequest) -> PrevisitResponse:
    return previsit(req)


@app.post("/clinical/search")
def clinical_search(req: SearchRequest) -> list[dict]:
    return search(req)
