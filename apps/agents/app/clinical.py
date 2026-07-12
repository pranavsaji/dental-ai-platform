"""Clinical ops agent: pgvector RAG over chart notes.

- embed_pending(): embeds clinical commlog notes into note_embeddings
  (bge-small-en-v1.5 via fastembed, 384 dims — local, no API dependency)
- previsit(): pre-visit summary for one patient, grounded in their chart notes
  with note-level citations
- search(): semantic note search across the location ("who did we treat for
  a cracked molar last spring?")
"""

from typing import Any

import psycopg
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from .config import PLATFORM_DATABASE_URL, llm_available
from .deid import Deidentifier
from .llm import invoke_structured

_embedder = None


def _get_embedder():
    global _embedder
    if _embedder is None:
        from fastembed import TextEmbedding
        _embedder = TextEmbedding("BAAI/bge-small-en-v1.5")
    return _embedder


def _conn() -> psycopg.Connection:
    return psycopg.connect(PLATFORM_DATABASE_URL.replace("postgres://", "postgresql://"))


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def embed_pending(location_id: int | None = None) -> dict:
    """Embed clinical notes (comm_type=3) that don't have embeddings yet."""
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT c.org_id, c.location_id, c.source_id, c.patient_source_id, c.note
            FROM comm_logs c
            LEFT JOIN note_embeddings e
              ON e.location_id = c.location_id AND e.comm_log_source_id = c.source_id
            WHERE c.comm_type = 3 AND e.id IS NULL
              AND (%(loc)s::bigint IS NULL OR c.location_id = %(loc)s)
            LIMIT 2000
            """,
            {"loc": location_id},
        ).fetchall()
        if not rows:
            return {"embedded": 0}

        embeddings = list(_get_embedder().embed([r[4] for r in rows]))
        with conn.cursor() as cur:
            for (org_id, loc_id, src_id, pat_id, note), emb in zip(rows, embeddings):
                cur.execute(
                    """
                    INSERT INTO note_embeddings
                      (org_id, location_id, comm_log_source_id, patient_source_id, content, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s::vector)
                    ON CONFLICT (location_id, comm_log_source_id) DO NOTHING
                    """,
                    (org_id, loc_id, src_id, pat_id, note, _vec(list(emb))),
                )
        conn.commit()
        return {"embedded": len(rows)}


class SearchRequest(BaseModel):
    locationId: int
    query: str
    limit: int = 8


def search(req: SearchRequest) -> list[dict[str, Any]]:
    query_emb = list(_get_embedder().embed([req.query]))[0]
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT e.comm_log_source_id, e.patient_source_id, e.content,
                   1 - (e.embedding <=> %s::vector) AS similarity,
                   p.first_name, p.last_name
            FROM note_embeddings e
            LEFT JOIN patients p
              ON p.location_id = e.location_id AND p.source_id = e.patient_source_id
            WHERE e.location_id = %s
            ORDER BY e.embedding <=> %s::vector
            LIMIT %s
            """,
            (_vec(list(query_emb)), req.locationId, _vec(list(query_emb)), req.limit),
        ).fetchall()
    return [
        {
            "noteId": r[0],
            "patientSourceId": r[1],
            "patientName": f"{r[4]} {r[5]}" if r[4] else None,
            "content": r[2],
            "similarity": round(float(r[3]), 3),
        }
        for r in rows
    ]


class PrevisitRequest(BaseModel):
    locationId: int
    patientSourceId: int


class PrevisitResponse(BaseModel):
    summary: str
    citedNoteIds: list[int]
    usedLlm: bool


class _Summary(BaseModel):
    summary: str = Field(
        description="Pre-visit summary: 3-6 bullet points covering recent treatment, "
        "outstanding/planned work, perio status, and anything to raise chairside. "
        "Each clinical claim cites its source note like [note 123]."
    )
    cited_note_ids: list[int] = Field(description="commlog source ids actually cited")


def previsit(req: PrevisitRequest) -> PrevisitResponse:
    with _conn() as conn:
        patient = conn.execute(
            """
            SELECT first_name, last_name FROM patients
            WHERE location_id = %s AND source_id = %s
            """,
            (req.locationId, req.patientSourceId),
        ).fetchone()
        notes = conn.execute(
            """
            SELECT source_id, happened_at::date::text, note
            FROM comm_logs
            WHERE location_id = %s AND patient_source_id = %s AND comm_type = 3
            ORDER BY happened_at DESC
            LIMIT 12
            """,
            (req.locationId, req.patientSourceId),
        ).fetchall()
        planned = conn.execute(
            """
            SELECT pc.proc_code, pc.description, pr.fee
            FROM procedures pr
            LEFT JOIN procedure_codes pc
              ON pc.location_id = pr.location_id AND pc.source_id = pr.code_source_id
            WHERE pr.location_id = %s AND pr.patient_source_id = %s AND pr.status = 'planned'
            """,
            (req.locationId, req.patientSourceId),
        ).fetchall()

    if not notes:
        return PrevisitResponse(
            summary="No clinical notes on file for this patient yet.",
            citedNoteIds=[],
            usedLlm=False,
        )

    notes_block = "\n\n".join(f"[note {n[0]}] ({n[1]}) {n[2]}" for n in notes)
    planned_block = (
        "\n".join(f"- {p[0]} {p[1]} (${p[2]:.0f})" for p in planned) or "none on file"
    )

    if not llm_available():
        return PrevisitResponse(
            summary=(
                "(LLM key not configured — raw chart digest)\nMost recent notes:\n"
                + "\n".join(f"- [{n[0]}] {n[1]}: {n[2][:140]}…" for n in notes[:4])
            ),
            citedNoteIds=[n[0] for n in notes[:4]],
            usedLlm=False,
        )

    deid = Deidentifier()
    if patient:
        deid.register_person(f"{patient[0]} {patient[1]}")
    result = invoke_structured(_Summary, [
        SystemMessage(content=(
            "You are the clinical-operations agent for a dental practice, preparing a "
            "provider's pre-visit huddle summary. Use ONLY the supplied chart notes and "
            "treatment plan; if something isn't in them, don't say it. Cite every clinical "
            "claim with its [note id]. Flag overdue follow-ups (e.g. an RCT missing its "
            "crown, SRP without re-eval). Plain clinical language, no fluff."
        )),
        HumanMessage(content=(
            f"Chart notes (newest first):\n{notes_block}\n\n"
            f"Treatment-planned procedures:\n{planned_block}"
        )),
    ], max_tokens=2048, deid=deid)
    return PrevisitResponse(
        summary=result.summary, citedNoteIds=result.cited_note_ids, usedLlm=True
    )
