# Dental AI Platform — Feature Catalog

Every capability in the platform, what it does, how it's built, where the code lives,
and how to prove it works. Test walkthroughs are referenced as **T1–T14**; they live in
`run.md`, a runbook kept in the local working copy (not published to this repo).

---

## 1. System at a glance

| Layer | Tech | Port | Code |
|---|---|---|---|
| Provider/admin dashboard | Next.js 15 (App Router), Tailwind 4 | 3000 | `apps/web` |
| Control plane API + Temporal worker | NestJS 10, Drizzle ORM | 4100 | `apps/api` |
| AI agent service | Python 3.12, FastAPI, LangGraph | 8100 | `apps/agents` |
| Workflow engine | Temporal (self-hosted) | 7233 (UI 8233) | — |
| Platform DB | PostgreSQL 16 + pgvector | 5442 | `packages/db` |
| Edge Synchronizer (×2 sites) | TypeScript worker | — | `apps/edge-sync` |
| Simulated OpenDental (×2 sites) | MySQL 8, real OD schema subset | 3307 / 3308 | `tools/seed` |
| Shared wire contracts | zod | — | `packages/shared` |

The core thesis: **the cloud never touches the Practice Management System directly.**
All reads arrive as change-capture events from the edge; all writes leave as durable
commands the edge applies and acknowledges. Everything in between is canonical,
multi-tenant, audited, and orchestrated by Temporal.

---

## 2. Edge Synchronizer (`apps/edge-sync`) — *test: T2, T3, T10*

The on-prem agent that bridges a practice's OpenDental server to the cloud. One process
per location (`EDGE_SITE=a|b`), three loops on one 3-second tick:

| Feature | How it works | Code |
|---|---|---|
| **Change data capture** | Polls each of 12 OpenDental tables on its `DateTStamp` column with a **keyset cursor `(stamp, pk)`** — paginates correctly through bulk changes where thousands of rows share one TIMESTAMP second (a plain `>= stamp` cursor loops forever). Reference tables sync before dependents (`SYNC_ORDER`). | `src/main.ts` `captureTable`, `src/transform.ts` |
| **Canonical transformation** | The PMS-specific boundary: raw OpenDental rows (PascalCase, status enums, `0001-01-01` sentinel dates) become canonical camelCase payloads validated by shared zod contracts. Nothing north of this file knows OpenDental column names. | `src/transform.ts` (unit-tested, T11) |
| **At-least-once delivery, exactly-once effect** | Events carry deterministic ids `site:table:pk:stamp`; the cloud dedupes on them, so crash-replay is safe. Batches of ≤200 over HTTPS with a per-site API key. | `src/main.ts`, `cloud.ts` |
| **Durable local outbox** | Captured events persist to a local state file (atomic tmp+rename) until the cloud acks; cursors advance only after enqueue. Cloud down ≠ data loss; capture keeps running. Exponential backoff (5s→60s) on push failure. | `src/state.ts` |
| **Command write-back** | Polls `/edge/commands` for cloud-issued mutations — `BookAppointment`, `UpdateAppointmentStatus`, `AddCommlog` — applies each in a MySQL transaction, acks with the resulting OpenDental row id. Applied-command ids are remembered locally so a lost ack never double-books. | `src/writeback.ts`, `src/main.ts` `processCommands` |
| **Restart safety** | Kill the process at any point; on restart it resumes from persisted cursors, re-delivers unacked outbox events (deduped server-side), and applies pending commands exactly once. Proven live in T10. | `src/state.ts` |

## 3. Ingest & canonical data model (`apps/api/src/edge`, `packages/db`) — *test: T2*

| Feature | How it works | Code |
|---|---|---|
| **Per-site authentication** | `x-edge-api-key` resolved to `(org, location)`; every `/edge/*` request is scoped to exactly one site. | `edge-auth.guard.ts` |
| **Idempotent ingest** | Each event inserts into `sync_events` (PK = event id) first; conflicts count as duplicates and skip the upsert. Then an upsert into the canonical table keyed `(location_id, source_id)`. | `ingest.service.ts` |
| **Canonical multi-tenant schema** | 12 mirrored entities (patients, appointments, procedures, claims, claim procs, recalls, comm logs, providers, operatories, codes, plans, pat-plans) + platform tables (users, audit, commands, proposed actions, SMS, embeddings). Every row carries `org_id` + `location_id` + `source_stamp` + `synced_at` (powers the "synced 14s ago" provenance in the UI). | `packages/db/src/schema.ts` |
| **State-transition hooks** | Ingest compares previous vs new appointment status; a future appointment turning `broken` fires the workflow trigger exactly once, at ingest time — this is what makes the platform *reactive* to things that happen inside the PMS. | `ingest.service.ts`, `hooks.service.ts` |
| **Durable command queue** | Commands live in Postgres with lifecycle `pending → delivered → applied/failed` and stay servable until acked, so an edge crash between fetch and apply loses nothing. | `commands.service.ts` |

## 4. Control plane API (`apps/api`) — *test: T1, T8, T9*

| Feature | How it works | Code |
|---|---|---|
| **Auth** | Email + scrypt-hashed password → 12h JWT (`sub`, `orgId`, `role`, `locationId`). | `auth/auth.ts`, `packages/db/src/password.ts` |
| **RBAC** | Roles `admin` / `provider` / `staff`; audit log endpoint requires admin or provider (staff → 403). | `portal.service.ts` `auditEntries` |
| **Tenancy enforcement** | Every portal query is scoped through `resolveLocation(user, locationId)`: org always from the JWT; a location-restricted user cannot read or act on another location (403). Verified in T9. | `portal.service.ts` |
| **PHI audit trail** | Append-only `audit_log` — every schedule view, patient search, chart open, agent proposal, SMS send, command, and workflow start writes actor (`user` / `agent` / `edge` / `system`), action, resource, and purpose. Surfaced in the dashboard (T8). | `audit.service.ts`, callers throughout |
| **Portal read API** | Overview KPIs, day schedule (joined patient/provider/operatory), patient search, full chart timeline (appointments, procedures + CDT codes, notes, claims, recall, insurance), audit list. | `portal.controller.ts`, `portal.service.ts` |
| **Approval queue API** | List proposed actions; decide (`approved`/`rejected`) signals the owning Temporal workflow — the workflow, not the endpoint, owns the state machine. Falls back to a direct row update if the workflow is already gone. | `actions.controller.ts` |
| **SMS simulator API** | Outbound messages are written by workflow activities; inbound replies are routed to the workflow that most recently texted that patient (`workflowId` on the message) and delivered as a Temporal signal. | `actions.controller.ts` |
| **Ops API** | Start recall-campaign / claim-follow-up workflows on demand; proxy clinical previsit + semantic chart search to the agent service (with PHI audit on each call). | `ops.controller.ts` |

## 5. Durable workflows (Temporal) (`apps/api/src/temporal`) — *test: T3, T4, T5*

Workflows run in Temporal's deterministic sandbox (`workflows.ts` — no I/O); all side
effects live in Nest-injected activities (`activities.service.ts`). The worker runs
in-process with the API on task queue `dental-ops`. Human decisions and patient replies
arrive as **signals**; waits are real durable timers (24h approval windows, 4h reply
windows) — restart the API mid-workflow and everything resumes.

### 5.1 `cancellationBackfill` — the flagship (T3)
Started automatically when the edge reports a future appointment turned `broken`
(workflow id `backfill-<site>-<aptNum>` — duplicate starts are rejected, so one broken
appointment can never spawn two backfills).

1. **Agent proposes**: activity queries overdue-recall candidates without upcoming
   appointments, sends them to the scheduling agent, writes a proposed action (approval card).
2. **Human approves** (signal; 24h timeout → `expired`).
3. **Outreach SMS** sent; workflow parks on the patient-reply signal (4h timeout).
4. **Reply parsed**: YES → durable `BookAppointment` command; polls command status until
   the edge acks it applied *inside OpenDental*. NO → polite decline text, card closed.
5. **Finalize**: confirmation SMS, action marked `executed`, audit entries throughout.

### 5.2 `recallCampaign` — long-running batch loop (T4)
Operator-triggered. Selects the N most-overdue reachable patients, parks one approval
card for the batch, then sends rate-limited texts (2s durable sleep between sends).
Demonstrates the campaign/loop pattern with a single human gate.

### 5.3 `claimFollowUp` — durable external polling (T5)
Operator-triggered. Billing agent ranks aging claims and drafts the carrier letter →
approval → the letter is recorded to the patient chart **via edge write-back**
(`AddCommlog`) → the workflow then *owns the claim*, polling a mock clearinghouse
(probabilistic adjudication) with durable sleeps until `paid`, or escalating a
`claim_escalation` card back to a human on `denied`/stall.

## 6. AI agent service (`apps/agents`) — *test: T3–T7*

| Feature | How it works | Code |
|---|---|---|
| **Provider chain: DeepSeek primary → Anthropic fallback** | `invoke_structured()` tries providers in priority order: DeepSeek (`deepseek-chat` via `langchain-deepseek`) whenever `DEEPSEEK_API_KEY` is set; Anthropic (`claude-opus-4-8`) only when DeepSeek is unconfigured **or a DeepSeek call fails at runtime**. `GET /health` reports the resolved chain. Models overridable via `AGENTS_DEEPSEEK_MODEL` / `AGENTS_MODEL`. | `app/llm.py`, `app/config.py` |
| **Deterministic no-LLM fallbacks** | Every agent degrades gracefully to a template/heuristic when no key is configured or all providers fail — the platform demo never stalls on an LLM outage. Responses carry `usedLlm` so the UI can show which path ran. | `_fallback()` in each agent |
| **Scheduling agent** | LangGraph state machine `rank → draft`: structured-output ranking of backfill candidates (with conversion judgment, e.g. 6–18-months-overdue converts best), then SMS drafting under strict constraints (name practice, plain-words time, YES/NO ask, ≤320 chars, no invented clinical detail). | `app/scheduling.py` |
| **Billing agent** | LangGraph `prioritize → draft`: weighs days-outstanding, dollar value, expected payment; drafts a ≤150-word carrier status inquiry with a no-invented-identifiers guardrail. | `app/billing.py` |
| **Clinical RAG — embeddings** | Chart notes embed with **local** bge-small-en-v1.5 (fastembed, 384-dim) into pgvector with an HNSW cosine index. No PHI leaves the stack for embedding. Idempotent `embed_pending()` fills only missing rows. | `app/clinical.py` |
| **Clinical RAG — pre-visit summary** | Pulls the patient's newest 12 notes + treatment-planned procedures, generates a grounded huddle summary where **every clinical claim cites its `[note id]`**, flags overdue follow-ups (RCT missing crown, SRP without re-eval). Returns the cited ids for UI display. | `app/clinical.py` `previsit` |
| **Clinical RAG — semantic chart search** | Natural-language search across all notes at a location ("root canal with lingering pain"), cosine-ranked, joined to patient names. | `app/clinical.py` `search` |
| **Agent guardrails at the platform level** | The API validates that the agent's chosen patient is inside the candidate list it was given; agents can only act through proposed actions + commands — never direct DB writes to the practice. | `agents.client.ts`, architecture |

## 7. Dashboard (`apps/web`) — *test: T1, T3–T8*

Custom "clinical editorial" design system (Fraunces display serif, IBM Plex Sans/Mono,
pine/paper/mint palette, tabular numerals for all figures, reserved status colors).

| Page | Features |
|---|---|
| **Login** | JWT session, demo users listed, role-aware shell after login |
| **Overview** | Live KPI tiles (today's schedule, 7-day load, broken count, overdue recalls, active patients, open-claims value — auto-refresh 15s); **Agent operations** panel to launch recall campaign / claim follow-up; today's schedule table |
| **Schedule** | Day view with date paging; per-row status chips; broken rows highlighted; confirmed flags; links into charts |
| **Patients** | Name search + **semantic "ask the charts" search** (pgvector) with similarity scores linking to patients |
| **Patient chart** | Demographics with **sync provenance** ("synced from site A"); **AI pre-visit summary panel** with note citations; appointments, procedures (CDT codes + fees), clinical notes, claims, recall status, insurance |
| **Approvals** | The human-in-the-loop surface: pending agent proposals as cards (agent, type, workflow id, drafted message preview) with Approve/Reject; recent-decisions history; 5s auto-refresh |
| **SMS Console** | Chat-style simulator (stand-in for Twilio): agent outreach renders as practice bubbles; **reply as any patient** to drive workflows forward |
| **Audit Trail** | Live view of the append-only PHI log with actor-type badges (user/agent/edge); role-gated |
| **Location switcher** | Org-wide users flip between sites; location-restricted users are pinned to theirs |

## 8. OpenDental simulator (`tools/seed`) — *test: T2*

- Real OpenDental schema conventions: PascalCase columns, `*Num` PKs, `DateTStamp ON
  UPDATE CURRENT_TIMESTAMP` change tracking, status enums, `0001-01-01` sentinel dates —
  the edge's SQL would run unchanged against a genuine install.
- Deterministic synthetic data (seeded faker): 560 patients across 2 sites, 30 CDT
  procedure codes, providers/operatories, 18 months of visit history, a future schedule
  with realistic gaps, overdue recalls (~35%), aging insurance claims, and
  **template-generated clinical notes that read like real chart notes** (prophy, SRP,
  RCT, crown prep, extraction…) — which is what makes the RAG demo meaningful.
- Idempotent: `pnpm seed` drops and rebuilds; the cloud dedups on re-sync.

## 9. Identity, SMS delivery & compliance — *test: T8, T9, T13, T14*

**SSO (OIDC)** — real federated login, provider-agnostic:

| Feature | How it works | Code |
|---|---|---|
| Authorization Code + PKCE | `/auth/sso/login` redirects to any spec-compliant IdP (Google Workspace, Okta, Azure AD — set `OIDC_*` in `.env`); state/nonce/PKCE verifier ride in a 10-min signed httpOnly cookie, so the API stays stateless | `apps/api/src/auth/oidc.service.ts`, `sso.controller.ts` |
| ID-token verification | Issuer discovery + JWKS (RS256), audience/nonce checks | `oidc.service.ts` |
| Account linking | Verified `(issuer, subject)` → `auth_identities`; first login links by email; unknown emails rejected unless `OIDC_AUTO_PROVISION=true` (optionally fenced by `OIDC_ALLOWED_EMAIL_DOMAINS`); SSO-only users have no password hash | `sso.controller.ts`, `packages/db/src/schema.ts` |
| Token handoff | Callback redirects to `/login/sso#token=…` (fragment — never hits server logs); page verifies via `/auth/me` before storing | `apps/web/src/app/login/sso/page.tsx` |
| Local dev IdP | Zero-dep OIDC provider for testing the full flow offline: `node tools/dev-idp/server.mjs` | `tools/dev-idp/server.mjs` |

**Twilio SMS gateway** — pluggable delivery behind one seam:

| Feature | How it works | Code |
|---|---|---|
| Provider selection | Every agent text goes through `SmsService.send()`: with `TWILIO_*` creds it's a real Twilio send (E.164-normalized to the patient's wireless number, Message SID recorded); without, the row feeds the SMS Console simulator exactly as before | `apps/api/src/sms/sms.service.ts` |
| Inbound webhook | `POST /twilio/sms` — `X-Twilio-Signature` validated, sender matched to a patient by phone, reply threaded onto the workflow that last texted them (same routing as the simulator) and signalled into Temporal | `apps/api/src/sms/twilio.controller.ts` |
| Delivery reconciliation | `POST /twilio/status` callbacks update queued→sent→delivered/failed on the message row; visible in the SMS Console | same |

**Security hardening & compliance process:**

- Append-only audit of every PHI read/write with actor + purpose (T8); auth events
  (`auth.login`, `auth.login.failed`, `auth.sso.*`) now audited too
- RBAC + hard tenancy isolation (T9); per-site edge API keys; agents constrained
  to propose-then-approve
- Login rate limiting (10/5min/IP), `helmet` security headers, and a startup gate
  that refuses to boot production with dev-default secrets — `apps/api/src/security/config-check.ts`
- Local embeddings — chart text never sent to an external embedding API
- **`compliance/`** — SOC 2 Trust-Services control mapping (with code citations and
  gap list), BAA-readiness blockers (incl. the DeepSeek-cannot-sign-a-BAA problem),
  and access-control / incident-response / data-retention / vendor-management policies

## 10. Quality gates — *test: T11*

- Contract unit tests on the edge transform layer (every table's output validates
  against the shared zod schema the cloud enforces) — `apps/edge-sync/src/transform.test.ts`
- `typecheck` across all TS packages; strict TS everywhere
- Live-verified E2E scenarios recorded in `README.md` → Verification status

## 11. Environment reference

| Var | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Primary** LLM provider (agents) |
| `AGENTS_DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek model override |
| `ANTHROPIC_API_KEY` | — | **Fallback** LLM provider |
| `AGENTS_MODEL` | `claude-opus-4-8` | Anthropic model override |
| `API_PORT` / `API_URL` | 4100 | Control plane |
| `AGENTS_URL` | `http://localhost:8100` | Agent service |
| `PLATFORM_DATABASE_URL` | `postgres://dental:dental@localhost:5442/dental` | Platform DB |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Workflow engine |
| `OPENDENTAL_A_URL` / `OPENDENTAL_B_URL` | 3307 / 3308 | Simulated PMS |
| `EDGE_SITE_A_API_KEY` / `EDGE_SITE_B_API_KEY` | dev keys | Edge auth |
| `JWT_SECRET` | dev secret | Session signing |
| `WEB_URL` | `http://localhost:3000` | Web origin for CORS + SSO redirects |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | SSO; empty issuer = disabled |
| `OIDC_AUTO_PROVISION` / `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_DEFAULT_ROLE` | off / any / `staff` | SSO user provisioning rules |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | — | Real SMS; empty = console simulator |
| `TWILIO_WEBHOOK_BASE_URL` | `API_URL` | Public HTTPS base for signature validation + status callbacks |
| `EDGE_POLL_MS` | 3000 | Edge tick interval |
| `TEMPORAL_DISABLED` | — | Set `1` to run the API without Temporal |
