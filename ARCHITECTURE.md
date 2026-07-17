# Dental AI Platform — Technical Architecture

An AI-native operating system for multi-location dental groups (DSOs). The platform is
an intelligent **control plane** that sits above a legacy Practice Management System
(OpenDental), unifies data across locations, orchestrates AI agents through durable
workflows, and automates scheduling, billing, and clinical operations — with a human
approval gate in front of every consequential action.

Everything runs locally at zero cloud cost, but every layer is real (no mocks at the
boundary that matters — the PMS sync). The stack maps 1:1 to a production deployment:
**NestJS · LangGraph · Temporal · PostgreSQL + pgvector · Next.js**.

---

## 1. System overview

```
┌────────────────────────────── "CLOUD" (control plane) ──────────────────────────────┐
│                                                                                      │
│   apps/web (Next.js :3000)  ←──cookie session──→  apps/api (NestJS :4100)           │
│   role-aware dashboards,                          multi-tenant portal API,           │
│   approvals, SSE realtime                         auth/RBAC/audit, edge ingest,      │
│                                                   command queue, SMS/email policy    │
│                                                        │              │              │
│                                        Temporal (:7233, UI :8233)    │              │
│                                        11 durable workflows,         │              │
│                                        worker in the API process     │              │
│                                                        │              ▼              │
│   PostgreSQL 16 + pgvector (:5442) ◄──────────────────┴──── apps/agents (Py :8100)  │
│   canonical model, audit chain,                             FastAPI + LangGraph:     │
│   metrics, embeddings                                       scheduling, billing,     │
│                                                             clinical RAG, intent,    │
│                                                             huddle, insights         │
└──────────────────────────────────▲───────────────────────────────────────────────────┘
                 per-site API key  │  idempotent event batches ↑ / durable commands ↓
┌──────────────────────────────────▼──────────────── "ON-PREM" (per location) ─────────┐
│   apps/edge-sync ×2 — change-capture (keyset cursor on DateTStamp), durable outbox,  │
│                       command write-back, heartbeats, adapter fallback               │
│   MySQL "OpenDental" ×2 (:3307 site A, :3308 site B) — real OD schema subset         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Tech | Port | Code |
|---|---|---|---|
| Dashboard | Next.js 15 (App Router, React 19), Tailwind 4, motion 12, three.js/R3F 9 | 3000 | `apps/web` |
| Control plane API + Temporal worker | NestJS 10, Drizzle ORM | 4100 | `apps/api` |
| AI agent service | Python 3.12, FastAPI, LangGraph | 8100 | `apps/agents` |
| Workflow engine | Temporal (self-hosted) | 7233 (UI 8233) | — |
| Platform DB | PostgreSQL 16 + pgvector | 5442 | `packages/db` |
| Edge Synchronizer (×2 sites) | TypeScript worker | — | `apps/edge-sync` |
| Simulated OpenDental (×2 sites) | MySQL 8, real OD schema subset | 3307 / 3308 | `tools/seed` |
| Shared wire contracts | zod | — | `packages/shared` |

### Core design principles

1. **The edge is the only thing that touches the PMS.** Reads are change-capture polls;
   writes are cloud-issued commands the edge applies and acknowledges. Nothing north of
   the edge transformer knows OpenDental column names.
2. **Canonical model, tenancy everywhere.** Cloud records are keyed
   `(location_id, source_id)`, every row carries `org_id`, and every portal query is
   scoped through the session (org from JWT, location pinning, provider row-scoping).
3. **Agents propose; humans dispose.** Agents never mutate practice data directly. They
   produce *proposed actions*; Temporal parks the workflow on a signal until a human
   approves in the dashboard. AI never free-texts a patient autonomously.
4. **Durable execution.** Approval waits (24h), patient-reply windows (4h), payer
   polling, and campaign rate limiting are real Temporal timers — kill any process
   mid-workflow and everything resumes.
5. **HIPAA control patterns, demonstrated honestly.** Hash-chained append-only audit of
   every PHI access with actor + purpose; RBAC; per-site keys; PHI de-identification
   before any external LLM call; local embeddings. (Synthetic data only — this
   demonstrates the control patterns, not a compliance claim; see `compliance/`.)
6. **Graceful AI degradation.** Every agent has a deterministic no-LLM fallback, so the
   platform never stalls on an LLM outage. Responses carry `usedLlm`.

---

## 2. Monorepo layout

```
apps/api          NestJS control plane (14 controllers), Temporal client + in-process worker
apps/edge-sync    Edge Synchronizer (EDGE_SITE=a|b), pluggable PMS adapters
apps/agents       Python FastAPI + LangGraph agent service
apps/web          Next.js dashboard
packages/shared   zod event + command contracts (the edge↔cloud wire format)
packages/db       Drizzle schema + bootstrap (org, locations, demo users, metrics history)
tools/seed        OpenDental schema DDL + deterministic synthetic-data seeder
tools/simulator   Live practice simulator (named scenarios + continuous mode)
tools/mock-od-api Mock OpenDental REST API (for PMS_MODE=api testing)
tools/dev-idp     Zero-dep local OIDC provider (SSO testing)
infra/terraform   AWS deployment baseline (design artifact, staged in infra/README.md)
compliance/       SOC 2 control mapping, BAA-readiness blockers, policies
```

---

## 3. Edge Synchronizer (`apps/edge-sync`)

One process per location. Three loops on one 3-second tick (`EDGE_POLL_MS`):
**capture** → **drain** → **commands**.

- **Pluggable PMS adapters** (`src/adapters/`): `PMS_MODE = mysql | api | mock`.
  - `mysql` — direct connection to the practice's OpenDental database. Change capture
    uses **keyset pagination on `(DateTStamp, pk)`** — survives bulk imports where
    thousands of rows share one timestamp (a plain `>= stamp` cursor loops forever).
  - `api` — OpenDental REST API (`ODFHIR` developer/customer keys), same keyset
    semantics re-applied client-side. Optional webhook-hint listener triggers an
    immediate tick.
  - `mock` — embedded in-memory practice simulator; generates live activity on a timer.
  - **Fallback**: with `PMS_FALLBACK=mock`, 3 consecutive health failures hot-swap to
    the mock adapter and report `degraded` via heartbeat (visible in the UI badge).
- **13 tables synced** in reference-first order: provider, operatory, procedurecode,
  insplan, patient, patplan, appointment, procedurelog, claim, claimproc, recall,
  commlog, payment.
- **Canonical transformation** (`src/transform.ts`): the single PMS-specific boundary.
  OpenDental PascalCase rows → canonical camelCase payloads validated by shared zod
  contracts (status-enum maps, `0001-01-01` sentinel handling). Unit-tested.
- **At-least-once delivery, exactly-once effect**: deterministic event ids
  `site:table:pk:stamp`; the cloud dedupes on them. Batches ≤200 with a per-site
  `x-edge-api-key`.
- **Durable local outbox** (`src/state.ts`): events persist to a state file
  (atomic tmp+rename) until acked; cursors advance only after enqueue; exponential
  backoff (5s→60s) when the cloud is down. First run = full backfill from epoch.
- **Command write-back** (`src/writeback.ts`): polls `/edge/commands` for
  `BookAppointment`, `UpdateAppointmentStatus`, `ConfirmAppointment`, `AddCommlog`;
  applies each in a MySQL transaction; acks with the resulting OpenDental row id.
  Applied-command ids are remembered locally, so a lost ack never double-books.
- **Heartbeats**: `POST /edge/heartbeat` each tick reports configured/active mode and
  live/degraded status — powers the integration badge and Admin → Locations provenance.

## 4. Control plane API (`apps/api`)

### 4.1 Ingest & command queue (`src/edge`)

- `EdgeAuthGuard` resolves `x-edge-api-key` → `(org, location)`; every `/edge/*` request
  is scoped to exactly one site.
- Idempotent ingest: each event first inserts into `sync_events` (PK = event id);
  conflicts are counted as duplicates and skipped; then an upsert into the canonical
  table keyed `(location_id, source_id)`.
- **State-transition hooks** (`hooks.service.ts`) make the platform *reactive* to things
  that happen inside the PMS: a future appointment turning `broken` starts
  `cancellationBackfill`; a new upcoming appointment starts a targeted
  `insuranceVerification`; a treatment-planned procedure needing pre-auth starts
  `preAuthorization`. All idempotent by deterministic workflow id.
- Durable command queue in Postgres: `pending → delivered → applied/failed`; commands
  stay servable until acked, so an edge crash between fetch and apply loses nothing.

### 4.2 Portal API surface (all `@UseGuards(JwtGuard)`)

| Controller | Prefix | Highlights |
|---|---|---|
| Portal | `/portal` | me, locations, overview KPIs, day schedule, patient search, chart timeline, audit list, **audit chain verify** |
| Actions | `/portal` | approval queue, decide (signals the owning workflow), SMS/email consoles, inbound SMS simulator |
| Ops | `/portal/ops` | start recall-campaign / claim-followup / huddle / reminder-sweep / treatment-outreach / metrics-rollup workflows; owner insights; **AI previsit + semantic chart search** (proxied to agents, PHI-audited) |
| Tasks | `/portal/tasks` | list/summary/create/claim/resolve + staff-reviewed SMS reply |
| Billing | `/portal/billing` | summary KPIs, claims worklist, denials, pre-auths, eligibility, unscheduled treatment, payments ledger, claim follow-up, eligibility sweep, statement email |
| Analytics | `/portal/analytics` | cross-location summary + trends (org-wide admin only) |
| Admin users | `/portal/admin/users` | invite, role/location/provider link, disable/enable, password + MFA resets |
| Admin locations | `/portal/admin/locations` | timezone + auto-send-reminders policy |
| Events | `/portal/events` | **SSE stream** (cookie-authenticated) + notification backlog |
| Auth / MFA / SSO | `/auth`, `/auth/mfa`, `/auth/sso` | see §5 |
| Twilio | `/twilio` | signed inbound + delivery-status webhooks (no JWT; Twilio signature) |
| Edge | `/edge` | sync ingest, command fetch/ack, heartbeat (edge API key) |

## 5. Identity, RBAC & security

### 5.1 Sessions
- **httpOnly cookie sessions + CSRF double-submit** (`auth/session.ts`): the 12h JWT
  lives in `dental_session` (httpOnly, SameSite=Lax, Secure in prod); a paired
  non-httpOnly `dental_csrf` cookie must be echoed as `x-csrf-token` on every
  cookie-authenticated mutation. **Bearer tokens still work** for scripts/tools (no
  CSRF needed).
- Disabled accounts are revoked within 30s (in-memory cache with explicit invalidation
  on disable).
- Login rate limiting: 10 attempts / 5 min / IP (fixed window, counts successes too);
  failures are audit-logged.

### 5.2 MFA (TOTP)
Enrollment via QR (otplib), 8 single-use scrypt-hashed recovery codes. Login becomes a
two-step flow with short-lived stage tokens. `MFA_ENFORCE_ADMIN`: off in dev, on in
production (admins are forced to enroll at login).

### 5.3 SSO (OIDC)
Provider-agnostic Authorization Code + PKCE (Google/Okta/Azure AD via `OIDC_*` env).
ID tokens verified against JWKS (RS256, audience/issuer/nonce). In-flight txn state
rides a 10-min signed cookie, so the API stays stateless. Account linking by
`(issuer, subject)` → then by email; unknown emails rejected unless
`OIDC_AUTO_PROVISION=true` (fenced by `OIDC_ALLOWED_EMAIL_DOMAINS`). A zero-dependency
local IdP (`tools/dev-idp`) tests the full flow offline. Note the flow's two moving
parts: the API must reach `OIDC_ISSUER` (discovery + token exchange; failure surfaces
as `#error=idp_unreachable`), and the success/error callback redirects the **browser**
to `WEB_URL/login/sso` — so the web app must actually be serving at `WEB_URL`.
`GET /auth/sso/status` also reports `issuerIsLocal`; the login page uses it to hide
the SSO button on hosted deploys when the configured IdP is a localhost dev IdP
(unreachable for visitors), so the dev IdP never leaks into production UX.

### 5.4 RBAC — four roles
Single source of truth: the `POLICY` matrix in `apps/api/src/auth/roles.ts`, enforced
with `assertCan(user, "<permission>")` on endpoints and mirrored by nav gating in the
web shell. `roles.test.ts` asserts the full matrix.

| Permission | admin | provider | billing | staff |
|---|:-:|:-:|:-:|:-:|
| schedule.read, patients.read, eligibility.read, tasks.act | ✅ | ✅ | ✅ | ✅ |
| clinical.ai, huddle.run | ✅ | ✅ | — | ✅ |
| comms.read, approvals.act, statements.send | ✅ | — | ✅ | ✅ |
| comms.simulate, campaigns.run, metrics.rollup | ✅ | — | — | ✅ |
| billing.read, billing.act | ✅ | — | ✅ | — |
| analytics.read, metrics.backfill, audit.read, admin.manage | ✅ | — | — | — |

- **Provider row-scoping**: provider-role users are linked to a PMS provider via
  `users.provider_source_id` and see only their own schedule/patients (patients whose
  primary provider is them, or whom they've seen). The scope **fails closed** — an
  unlinked provider account gets 403. Dollar fields are nulled for roles without
  `billing.read`.
- **Tenancy**: org always from the JWT; a location-pinned user cannot read or act on
  another location (403). Analytics additionally requires an org-wide (unpinned) admin.

### 5.5 Tamper-evident audit log
Append-only `audit_log` where every entry commits to the previous entry's hash:
`entry_hash = sha256(prev_hash + canonical_json(entry))`, serialized by a Postgres
advisory lock. Any retroactive edit/delete/reorder breaks every subsequent hash.
`GET /portal/audit/verify` re-walks the chain on demand (and the verify itself is
audited); a nightly Temporal cron (`audit-chain-verify`, 03:30) does the same and files
an urgent task if the chain is broken. Every PHI read/write, agent proposal, SMS/email
event, command, workflow start, auth event, and admin action is logged with actor type
(user / agent / edge / system) and purpose.

### 5.6 Other hardening
helmet security headers; single-origin CORS with credentials; a production boot gate
that refuses dev-default secrets (`security/config-check.ts`); Twilio webhook signature
validation (503 when unconfigured, 403 on bad signature); edge keys never shipped to
the browser; PHI **de-identification before external LLM calls** (see §7); local-only
embeddings; GitHub Actions CI; app Dockerfiles (`--profile apps`).

## 6. Durable workflows (Temporal, `apps/api/src/temporal`)

Workflows are deterministic (`workflows.ts`, no I/O); all side effects live in
Nest-injected activities (`activities.service.ts`, ~38 activities). The worker runs
in-process with the API on task queue `dental-ops`. Human decisions and patient replies
arrive as **signals** (`approval`, `smsReply`, `taskResolved`).

| Workflow | Trigger | What it does |
|---|---|---|
| `cancellationBackfill` | ingest hook: future appt → broken | agent ranks overdue-recall candidates → approval card → SMS cascade (4h reply window per candidate) → YES books via durable edge command → confirmation |
| `recallCampaign` | operator / on-demand | N most-overdue reachable patients → one batch approval → channel-aware rate-limited outreach |
| `claimFollowUp` | operator or per-claim button | billing agent picks/drafts → approval → letter recorded to chart via write-back → durably polls clearinghouse → paid, or denial branch (classify CARC → appeal draft → 2nd approval → poll appeal to won/lost) |
| `insuranceVerification` | cron 05:00 + new-appointment hook | eligibility sweep (deterministic payer mock), red/amber failures become tasks |
| `preAuthorization` | ingest hook: planned proc needing pre-auth | drafts clinical narrative citing note ids → approval → submits → polls payer; `more_info` parks on task resolution (14d cap) |
| `treatmentOutreach` | cron 07:00 + operator | unscheduled-treatment backlog → approval → SMS; each YES spawns a detached `rescheduleConversation` child |
| `rescheduleConversation` | inbound CHANGE keyword / outreach YES | deterministic slot-offer conversation (no LLM); books via edge command |
| `reminderSweep` | cron 16:00 + operator | tomorrow's unconfirmed → batch approval (skipped where location `autoSendReminders`) → SMS; C/YES writes Confirmed back into the PMS |
| `morningHuddle` | cron 06:00 + operator | scores no-show risk, generates the huddle digest (narrative + ranked actions) |
| `metricsRollup` | cron 02:30 (days=1) + admin backfill | recomputes `daily_location_metrics` |
| `auditChainVerify` | cron 03:30 (global) | verifies the audit hash chain end-to-end |

Cron times run on the server clock (UTC in practice). All crons have manual
`POST /portal/ops/*` triggers for demos. Workflow ids are deterministic
(`backfill-a-123`, `elig-sweep-a`, …) so duplicate starts are rejected.

## 7. AI agent service (`apps/agents`, FastAPI + LangGraph)

### Provider chain & guardrails
- `invoke_structured()` is the single LLM choke point: **DeepSeek primary**
  (`deepseek-chat`) → **Anthropic fallback** (`claude-opus-4-8`), falling through on
  runtime errors; if all providers fail, the caller's **deterministic fallback**
  template runs. `GET /health` reports the resolved chain. Responses carry `usedLlm`.
- **PHI de-identification** (`app/deid.py`): before any prompt leaves the process,
  patient names/phones/emails are replaced with deterministic tokens
  (`[PATIENT_7]`, `[PHONE_1]`), and all string fields of the structured output are
  re-hydrated afterward. Multi-node graphs share one token map.
- Platform-level guardrails: the API validates the agent's chosen patient is inside the
  candidate list it was given; agents act only through proposed actions + commands.

### Agents
| Endpoint | Agent | Shape |
|---|---|---|
| `POST /scheduling/propose` | backfill candidate ranking + SMS draft | LangGraph `rank → draft`; deprioritizes ≥2 prior no-shows |
| `POST /scheduling/outreach` | unscheduled-treatment batch outreach | rank + draft |
| `POST /billing/review` | aging-claim prioritization + carrier letter | LangGraph `prioritize → draft` |
| `POST /billing/eligibility-summary` · `/preauth-draft` · `/appeal-draft` | eligibility summary; pre-auth narrative (cites note ids); denial appeal (CARC category is deterministic — the LLM may not recharacterize) | single-call |
| `POST /sms/intent` | inbound SMS intent router: `question / billing_question / reschedule / confirm / other` + suggested staff-reviewed reply | single-call |
| `POST /ops/huddle` | morning-huddle narrative + ≤5 ranked role-tagged actions | single-call over pre-gathered facts |
| `POST /ops/insights` | owner metric-delta Q&A over rollups (z-scores; correlations, not causes) | single-call |
| `POST /clinical/embed` · `/previsit` · `/search` | clinical RAG (below) | — |

### Clinical RAG — local by design
Chart notes embed with **bge-small-en-v1.5 (fastembed, 384-dim, fully local)** into
pgvector (`note_embeddings`, HNSW cosine index) — no PHI leaves the stack for
embeddings. `previsit` pulls the patient's newest 12 notes + planned procedures and
generates a grounded huddle summary where **every clinical claim cites its `[note id]`**;
`search` is natural-language semantic search across all notes at a location, with
provider row-scope filtering applied by the API.

## 8. Communications layer (SMS + email)

- **One policy enforcement point**: every outbound patient message goes through
  `SmsService.send()` / `EmailService.sendToPatient()`, which evaluate the pure policy
  in `sms/policy.ts`. Message kinds: `outreach` (consent + quiet hours + frequency
  caps), `conversation`/`confirmation`/`notice` (consent only). Quiet hours =
  08:00–20:00 patient-local (prefs timezone → location timezone fallback, DST-safe);
  caps = 2/day, 6/week (outreach only). Blocked messages land as typed `blocked_*`
  rows; quiet-hours outreach is **queued** (`send_after`) and flushed by a 30s outbox —
  never dropped.
- **Sticky opt-out**: STOP/UNSUBSCRIBE permanently sets `smsConsent=false`
  (`consent_source=sms_stop`) and blocks queued sends.
- **Twilio gateway** (optional): with `TWILIO_ACCOUNT_SID + AUTH_TOKEN + FROM_NUMBER`
  set, sends are real (E.164-normalized, Message SID recorded, status callbacks
  reconcile queued→sent→delivered/failed). Without them, rows feed the **SMS Console
  simulator** — identical platform history, routing, and audit. Inbound
  (`POST /twilio/sms`) and status (`POST /twilio/status`) webhooks validate
  `X-Twilio-Signature` against `TWILIO_WEBHOOK_BASE_URL`.
- **Inbound router** (E2): STOP → opt-out; CHANGE/RESCHEDULE → starts
  `rescheduleConversation`; otherwise threads the reply into the workflow that last
  texted the patient (if still running); otherwise classifies intent and files a
  `patient_question` task with an editable suggested reply — a human always sends it.
- **Email channel** (E3): same policy seam; SMTP via `SMTP_URL`/`EMAIL_FROM`, else a
  console Email tab; versioned templates.

## 9. Data model (`packages/db/src/schema.ts`)

| Domain | Tables |
|---|---|
| Tenancy / auth | `orgs`, `locations` (timezone, autoSendReminders, integration provenance), `users` (role, location pin, provider link, MFA), `auth_identities` (SSO) |
| Canonical PMS mirrors | `providers`, `operatories`, `procedure_codes`, `patients`, `appointments` (+ no-show risk), `procedures`, `ins_plans`, `pat_plans`, `claims` (+ CARC codes), `claim_procs`, `recalls`, `comm_logs`, `payments` — all keyed `(location_id, source_id)` with `source_stamp`/`synced_at` provenance |
| Sync plumbing | `sync_events` (dedup), `edge_commands` (durable queue) |
| Platform | `audit_log` (hash chain), `proposed_actions`, `sms_messages`, `email_messages`, `tasks`, `patient_contact_prefs`, `daily_location_metrics`, `eligibility_checks`, `preauths`, `claim_denials`, `huddle_digests`, `notifications`, `note_embeddings` (pgvector) |

`bootstrap.ts` (idempotent) creates the demo org **Lone Star Dental Group**, two
locations (Austin — North Lamar / Round Rock), four demo users (see RUN_AND_TEST.md),
starter tasks, and 90 days of synthetic metrics history per location.

## 10. Web app (`apps/web`)

### Pages
| Route | Purpose | Role gate |
|---|---|---|
| `/` Overview | huddle digest card, 7 KPI tiles, agent-operations panel, today's schedule | per-button by role |
| `/dashboard` Org Dashboard | owner rollup: clinic cards with sparklines + health flags, drill-down trends, AR aging | admin |
| `/analytics` DSO Analytics | cross-location comparison table (worst-in-column flags), trend grids, natural-language insights | admin (org-wide) |
| `/schedule` | day view with eligibility dots (B2) + no-show risk badges (C4) | all |
| `/patients` (+ detail) | search, semantic "ask the charts", chart timeline with pre-auth badges, AI pre-visit summary, statement email | all (provider row-scoped) |
| `/billing` | AR-aging tiles, claims worklist, denials + appeal status, pre-auths, payments ledger, unscheduled treatment | admin, billing |
| `/approvals` | the human-in-the-loop surface (5s poll) | admin, billing, staff |
| `/tasks` | work queue: claim/resolve, intent-routed patient questions with draft replies | all |
| `/sms` | comms console: SMS + Email tabs, policy outcomes inline, reply-as-patient simulator | admin, billing, staff |
| `/audit` | audit trail + chain-verify button | admin |
| `/account` | profile + voluntary MFA enrollment | all |
| `/admin/users`, `/admin/locations` | user management (F3), location settings (G1) | admin |
| `/login`, `/login/sso` | password + MFA challenge/enrollment flows, SSO button, WebGL hero | — |

- **Shell** (`components/shell.tsx`): role-filtered nav (mirrors the POLICY matrix),
  location switcher (pinned users locked), integration heartbeat badge, task-count
  badge, and a **realtime notification bell** fed by a cookie-authenticated
  `EventSource` on `/portal/events` (SSE), with polling fallbacks.
- **Client API** (`lib/api.ts`): cookie-credentialed fetches; CSRF cookie echoed on
  mutations; 401 → clean logout; localStorage holds only the non-sensitive profile.
- **RBAC gating**: `RequireRole` renders a friendly gate instead of children — cosmetic
  only; every endpoint re-checks the same matrix server-side.

### Design system & UI stack
"Clinical editorial" theme: Fraunces display serif + IBM Plex Sans/Mono, warm
paper/pine/mint palette with reserved status colors, tabular numerals, glass surfaces,
grain texture (Tailwind v4 CSS-first `@theme` tokens; fixed light theme).

- **WebGL** (`components/three/`): shader-driven aurora scenes (login hero + in-app
  ambient backdrops) via react-three-fiber. All guardrails centralized in
  `SceneCanvas`: CSS fallback when WebGL is unavailable or the context is lost, single
  static frame under `prefers-reduced-motion`, frameloop paused on hidden tabs,
  adaptive DPR on weak GPUs, `IntersectionObserver` unmounts offscreen canvases.
- **Motion** (`components/motion/`): LazyMotion primitives (`Rise`, `StaggerList`,
  spring-animated KPI numbers, pointer-tilt cards) with a shared easing/spring
  vocabulary; respects reduced motion.
- **Charts** (`components/charts/`): animated SVG area/line charts with crosshair
  tooltips, comparison bars with worst-performer flagging, AR-aging bars.
- **Capabilities** (`lib/capabilities.ts`): SSR-safe hooks (WebGL probe, reduced
  motion, page visibility, coarse pointer) that default conservative before hydration.

## 11. Dev & simulation tooling (`tools/`)

- **seed** — drops/rebuilds the two simulated OpenDental MySQL databases with real OD
  schema conventions (PascalCase, `*Num` PKs, `DateTStamp ON UPDATE`, status enums) and
  deterministic synthetic data: ~560 patients, 18 months of history, future schedules
  with gaps, overdue recalls, aging claims, CARC denial codes, and template-generated
  clinical notes that read like real chart notes (what makes the RAG demo meaningful).
- **simulator** — live practice activity: `pnpm simulate live` (one event/~30s) or named
  scenarios: `flagship-loop`, `busy-morning`, `denial-storm`, `preauth-crown`,
  `treatment-backlog`, `no-show-week` (`--site --speed --seed`).
- **mock-od-api** — OD-REST-shaped fixture server for testing the `api` edge adapter.
- **dev-idp** — local OIDC provider (PKCE, RS256, user-picker page) for SSO testing.
- A deterministic **mock clearinghouse/payer** inside the platform powers eligibility
  verdicts, pre-auth outcomes, claim adjudication, and CARC denials (same input → same
  outcome, so demos are reproducible).

## 12. Deployment topology

### Local (development)
Docker Compose infra (2× MySQL, Postgres+pgvector, Temporal + UI) + five processes:
API, edge×2, agents, web. See `RUN_AND_TEST.md`.

### Production (current) — Vercel + Railway + Neon
The platform runs fully in the cloud, no dev machine involved:

```
Browser ──HTTPS──▶ Vercel (Next.js)  https://dental-ai-platform.vercel.app
                     │  rewrite /backend/:path*  (next.config.ts, API_PROXY_TARGET env)
                     ▼
        Railway project "dental-ai-platform"
        ├── api      (apps/api Dockerfile)  ── public: api-production-f9f2.up.railway.app
        │      Temporal worker in-process; Twilio webhooks land here
        ├── agents   (apps/agents Dockerfile, private :8100, IPv6)
        ├── temporal (temporalio/auto-setup) ──▶ Postgres (Railway, dedicated —
        │      Temporal's persistence QPS overwhelms serverless Postgres)
        ├── edge-a / edge-b  (apps/edge-sync, PMS_MODE=mock — the practice
        │      simulator IS the PMS in the cloud; write-backs echo through it)
        └── Postgres (Temporal persistence only)
                     │
                     ▼
        Neon Postgres + pgvector (via Vercel Marketplace) — the platform DB:
        canonical records, embeddings, audit chain, metrics
```

Key wiring decisions:
- The `/backend` proxy keeps session cookies **first-party**, so the SameSite=Lax
  cookie security survives unchanged. Vercel env: `NEXT_PUBLIC_API_URL=/backend`,
  `API_PROXY_TARGET=<Railway api URL>`.
- Railway's private network is IPv6-only — services bind `::` (uvicorn flag, Temporal
  `BIND_ON_IP`); inter-service URLs use `<service>.railway.internal`.
- Cloud edges run `PMS_MODE=mock` (there is no on-prem PMS in the cloud): the embedded
  practice simulator generates live activity and applies write-back commands, so the
  flagship loop works end-to-end.
- Temporal persistence lives on a dedicated Railway Postgres, NOT Neon — serverless
  Postgres (autosuspend + small compute) caused chronic `context deadline exceeded`.
  The code also supports Temporal Cloud via `TEMPORAL_API_KEY`/`TEMPORAL_NAMESPACE`.
- Production secrets (strong `JWT_SECRET`, per-site edge keys) satisfy the API's boot
  gate; edge keys must match `locations.edge_api_key` in the DB (bootstrap/SQL).

### AWS path (design artifact)
`infra/terraform` holds a staged baseline (Aurora, ECS, KMS, Temporal Cloud swap);
stages 3–5 are design notes in `infra/README.md` — deliberately not applied.

## 13. Environment reference

| Var | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` / `AGENTS_DEEPSEEK_MODEL` | — / `deepseek-chat` | Primary LLM |
| `ANTHROPIC_API_KEY` / `AGENTS_MODEL` | — / `claude-opus-4-8` | Fallback LLM |
| `PLATFORM_DATABASE_URL` | `postgres://dental:dental@localhost:5442/dental` | Platform DB |
| `TEMPORAL_ADDRESS` / `TEMPORAL_DISABLED` | `localhost:7233` / — | Workflow engine |
| `API_PORT` / `API_URL` / `AGENTS_URL` / `WEB_URL` | 4100 / :4100 / :8100 / :3000 | Service wiring + CORS/SSO origin |
| `JWT_SECRET` | dev secret (prod refuses defaults) | Session signing |
| `OPENDENTAL_A_URL` / `OPENDENTAL_B_URL` | :3307 / :3308 | Simulated PMS |
| `EDGE_SITE_A_API_KEY` / `EDGE_SITE_B_API_KEY` | dev keys | Edge auth |
| `PMS_MODE[_A|_B]` / `PMS_FALLBACK` / `EDGE_POLL_MS` | `mysql` / — / 3000 | Edge adapters |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_AUTO_PROVISION` / `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_DEFAULT_ROLE` | dev IdP values | SSO |
| `MFA_ENFORCE_ADMIN` | off in dev, on in prod | Admin MFA |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | — | Real SMS (all three required; else console simulator) |
| `TWILIO_WEBHOOK_BASE_URL` | falls back to `API_URL` | Public HTTPS base for webhook signatures + status callbacks |
| `SMTP_URL` / `EMAIL_FROM` | — | Real email (else console) |
| `NEXT_PUBLIC_API_URL` / `API_PROXY_TARGET` | `http://localhost:4100` / — | Web→API wiring (hosted deploys use `/backend` + tunnel) |

## 14. Quality gates

- **149+ unit tests**: 133 in the API (vitest — RBAC matrix, provider scoping, message
  policy, audit chain, transforms, and more) + 16 edge-sync contract tests (every
  table's transform output validates against the shared zod schema); Python agents
  carry pytest + ruff.
- Strict TypeScript everywhere; `pnpm typecheck` across all 12 packages.
- GitHub Actions CI; app Dockerfiles (`docker compose --profile apps`).
- Live-verified E2E scenarios recorded in `README.md` → Verification status and
  `RUN_AND_TEST.md`.
