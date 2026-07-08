# Dental AI Platform — AI-Native Operating System for Dentistry (working MVP)

A full working implementation of the platform described in the founding-engineer brief:
an intelligent control plane that sits **above** a legacy Practice Management System
(OpenDental), unifies data across a multi-location dental group, orchestrates AI agents,
and automates scheduling, billing, and clinical workflows — with durable execution and a
human approval gate in front of every consequential action.

Everything runs locally at zero cloud cost, but the architecture maps 1:1 to the
production stack in the job description: **NestJS · LangGraph · Temporal · PostgreSQL +
pgvector · Next.js**, with a simulated on-premise OpenDental (the real schema, synthetic
data) standing in for the pilot practices.

> 📚 **Docs:** [`feature.md`](feature.md) — full feature catalog with code pointers.
> (The step-by-step runbook `run.md`, build plan, and compliance pack are kept in the
> local working copy, not published to this repo.)

## The flagship loop (60-second demo)

> A patient cancels tomorrow's appointment **directly inside OpenDental**. Within seconds
> the Edge Synchronizer pushes the change to the cloud, a Temporal workflow starts, the
> LangGraph scheduling agent picks the best overdue-recall patient and drafts an SMS, a
> human approves it in the dashboard, the patient replies YES, and the agent **books the
> appointment back into OpenDental** — full round trip, durable, audited.

This loop ran end-to-end in verification (see **Verification status** below). All state
transitions survive process crashes: the edge keeps an outbox with idempotency keys, the
booking is a durable command the edge acks, and the workflow itself is Temporal-backed.

## Architecture

```
┌─────────────────────────── "CLOUD" (control plane) ───────────────────────────┐
│  apps/web (Next.js :3000)  ←→  apps/api (NestJS :4100)  ←→  Postgres+pgvector │
│      provider dashboards        multi-tenant API, audit         (:5442)       │
│                                     │            │                            │
│                          Temporal (:7233, UI :8233)  apps/agents (Py :8100)   │
│                          durable workflows + worker   LangGraph agents:       │
│                          · cancellationBackfill       · scheduling            │
│                          · recallCampaign             · billing               │
│                          · claimFollowUp              · clinical (RAG)        │
└───────────────────────────────▲───────────────────────────────────────────────┘
              per-site API key · idempotent event batches ↑ / durable commands ↓
┌───────────────────────────────▼──────────── "ON-PREM" (per location) ─────────┐
│  apps/edge-sync ×2 — keyset change-capture on DateTStamp, outbox, write-back  │
│  MySQL "OpenDental" ×2 (:3307 site A, :3308 site B) — real schema subset      │
└────────────────────────────────────────────────────────────────────────────────┘
```

Key design decisions:

- **The edge is the only thing that touches the PMS.** Reads are change-capture polls on
  OpenDental's `DateTStamp` columns with a keyset cursor `(stamp, pk)` — survives bulk
  imports where thousands of rows share one timestamp. Writes are cloud-issued commands
  (`BookAppointment`, `AddCommlog`, …) that the edge applies transactionally and acks
  with the resulting OpenDental row id. At-least-once delivery both ways; the cloud
  dedupes on deterministic event ids, the edge dedupes on command ids.
- **Canonical model, tenancy everywhere.** The PMS-specific shape stops at the edge
  transformer. The cloud stores canonical records keyed `(location_id, source_id)`, every
  row carries `org_id`, and every portal query is scoped through the JWT (verified: a
  site-A user gets 403 on site-B data).
- **Agents propose; humans dispose.** Agents never mutate practice data directly. They
  produce *proposed actions*; Temporal parks the workflow on a signal until someone
  approves in the dashboard. Approval, outreach, patient reply, booking, and write-back
  confirmation are all steps of one durable workflow.
- **HIPAA patterns, demonstrated honestly.** Append-only audit log of every PHI access
  with actor + purpose (users, agents, and the edge all log), RBAC, per-site keys.
  Synthetic data only — this demonstrates the control patterns, not a compliance claim.
- **RAG stays local.** Clinical notes are embedded with a local model
  (bge-small-en-v1.5, 384 dims) into pgvector; the clinical agent's pre-visit summary
  cites the exact note ids it used. No PHI leaves the stack for embeddings.

## Repo layout

```
apps/api        NestJS control plane: edge ingest, command queue, portal API,
                auth/tenancy/audit, Temporal client + worker (workflows in
                src/temporal/workflows.ts, activities in activities.service.ts)
apps/edge-sync  Edge Synchronizer (TypeScript worker; EDGE_SITE=a|b)
apps/agents     Python FastAPI + LangGraph: scheduling, billing, clinical agents
apps/web        Next.js App Router dashboard (login, schedule, patients, approvals,
                SMS simulator, audit trail)
packages/shared zod event + command contracts (the edge↔cloud wire format)
packages/db     Drizzle schema for the platform Postgres + bootstrap script
tools/seed      OpenDental schema DDL + deterministic synthetic-data seeder
```

## Quickstart

Prereqs: Docker Desktop, Node 22+, pnpm 9+, [uv](https://docs.astral.sh/uv/) (Python 3.11+).

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY for real LLM output (optional —
                              # every agent has a deterministic no-LLM fallback)
pnpm install
docker compose up -d          # 2× MySQL (OpenDental sim), Postgres+pgvector, Temporal
pnpm seed                     # synthetic practices: ~560 patients, schedules, claims, notes
docker exec dental-postgres psql -U dental -d dental -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter @dental/db push && pnpm --filter @dental/db bootstrap
pnpm --filter @dental/shared build && pnpm --filter @dental/db build

# four processes (separate terminals, or add & to background them):
pnpm --filter @dental/api dev                       # control plane :4100 + Temporal worker
pnpm --filter @dental/edge-sync dev:a               # edge worker, site A
pnpm --filter @dental/edge-sync dev:b               # edge worker, site B
cd apps/agents && uv sync && uv run uvicorn app.main:app --port 8100
pnpm --filter @dental/web dev                       # dashboard :3000
```

Sign in at http://localhost:3000 — `admin@dental.dev` / `dental-demo`
(also `frontdesk@dental.dev` for the location-restricted view, `drpatel@dental.dev` for provider).
Temporal UI: http://localhost:8233.

## Demo script

1. **Watch the sync.** Overview shows live counts per location; edit any row in MySQL
   (`docker exec dental-opendental-a mysql -uod -podpass opendental`) and watch it land.
2. **The flagship loop.** Break a future appointment in OpenDental:
   ```sql
   UPDATE appointment SET AptStatus=5 WHERE AptNum = <a scheduled future AptNum>;
   ```
   → an approval card appears under **Approvals** within ~10s (agent-chosen patient +
   drafted SMS). Approve it → the text appears in **SMS Console** → reply `YES` as the
   patient → within seconds the appointment exists in OpenDental's `appointment` table,
   booked by the agent, and the patient gets a confirmation text. Follow along in the
   Temporal UI (`cancellationBackfill` workflow).
3. **Recall campaign.** Overview → *Run recall campaign* → approve the batch in
   Approvals → 5 rate-limited reactivation texts appear in the SMS console.
4. **Claim follow-up.** Overview → *Run claim follow-up* → approve → the drafted carrier
   letter is recorded to the chart via write-back, then the workflow durably polls the
   (mock) clearinghouse until the claim resolves or escalates back to a human.
5. **Clinical agent.** Any patient chart → *Generate pre-visit summary* (grounded in
   that chart's notes, with note-id citations). Patients page → the "Ask the charts"
   box does semantic search over all notes via pgvector.
6. **Compliance.** Audit Trail shows every PHI read/write above, attributed to the
   user, agent, or edge that did it, with purpose.

## What this deliberately is not (production roadmap)

Now built in: **SSO** (provider-agnostic OIDC with PKCE + a local dev IdP — run.md T13),
**Twilio SMS** (pluggable gateway with signed inbound/status webhooks; the console
simulator remains the zero-config default — run.md T14), and the **SOC 2 / BAA process
artifacts** (`compliance/`: control mapping with code citations, BAA-readiness blockers,
policies) plus hardening (prod refuses dev-default secrets, login rate limiting, helmet,
auth event auditing).

Documented rather than half-built: real AWS deploy (Aurora, ECS/EKS, KMS), Temporal
Cloud, real clearinghouse integration, OpenDental API-based integration as an
alternative to direct-DB, managed secrets store. The local stack was chosen so every
layer of the architecture is real and runnable, not mocked at the boundary that matters
(the PMS sync).

## Verification status

- Initial full sync: 560 patients / 2,733 appointments / 1,970 procedures / 1,184 notes
  mirrored across 2 sites; steady-state incremental sync <10s end-to-end.
- Flagship loop, recall campaign, and claim follow-up each run to `Completed` in Temporal
  with the approval gate exercised.
- Resilience: edge process killed with a booking command pending — on restart it applied
  the command exactly once (state file + command-id dedup) and the workflow completed.
- Tenancy: location-scoped user → 403 cross-location, 403 on audit (role-gated), 200 own.
- `pnpm --filter @dental/edge-sync test` — contract tests for the OpenDental→canonical
  transform layer (6 passing).
