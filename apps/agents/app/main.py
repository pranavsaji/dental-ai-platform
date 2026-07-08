from fastapi import FastAPI, HTTPException

from .billing import ReviewRequest, ReviewResponse, review
from .clinical import (
    PrevisitRequest, PrevisitResponse, SearchRequest, embed_pending, previsit, search,
)
from .config import MODEL, llm_available, provider_chain
from .scheduling import ProposeRequest, ProposeResponse, propose

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


@app.post("/billing/review", response_model=ReviewResponse)
def billing_review(req: ReviewRequest) -> ReviewResponse:
    try:
        return review(req)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/clinical/embed")
def clinical_embed(locationId: int | None = None) -> dict:
    return embed_pending(locationId)


@app.post("/clinical/previsit", response_model=PrevisitResponse)
def clinical_previsit(req: PrevisitRequest) -> PrevisitResponse:
    return previsit(req)


@app.post("/clinical/search")
def clinical_search(req: SearchRequest) -> list[dict]:
    return search(req)
