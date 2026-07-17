# Dental AI Platform — Run & Test Guide

Step-by-step instructions to set up, run, and test **every** feature of the platform,
plus the hosted (Vercel) demo procedure. Architecture background lives in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Desktop | running | `docker info` |
| Node | ≥ 22 | `node --version` |
| pnpm | ≥ 9 | `pnpm --version` |
| uv (Python manager) | recent | `uv --version` |

> macOS gotcha: if `docker compose up` hangs silently, remove `"credsStore"` from
> `~/.docker/config.json` and retry.

## 2. One-time setup

```bash
# 1. Environment (LLM keys optional — every agent has a deterministic fallback)
cp .env.example .env          # set DEEPSEEK_API_KEY (primary) and/or ANTHROPIC_API_KEY

# 2. JS deps + shared package builds
pnpm install
pnpm --filter @dental/shared build && pnpm --filter @dental/db build

# 3. Infrastructure (2× MySQL "OpenDental", Postgres+pgvector, Temporal + UI)
docker compose up -d

# 4. Seed the two practices (~560 synthetic patients; idempotent)
pnpm seed

# 5. Platform schema + demo org/users
docker exec dental-postgres psql -U dental -d dental -c "CREATE EXTENSION IF NOT EXISTS vector;"
pnpm --filter @dental/db push
pnpm --filter @dental/db bootstrap

# 6. Python agents deps
cd apps/agents && uv sync && cd ../..
```

## 3. Start the stack (5 processes)

Separate terminals (or `nohup ... &` with logs):

```bash
pnpm --filter @dental/api dev                                  # 1. control plane :4100 + Temporal worker
pnpm --filter @dental/edge-sync dev:a                          # 2. edge worker — site A (Austin)
pnpm --filter @dental/edge-sync dev:b                          # 3. edge worker — site B (Round Rock)
cd apps/agents && uv run uvicorn app.main:app --port 8100      # 4. AI agents
pnpm --filter @dental/web dev                                  # 5. dashboard :3000
```

First edge start performs the full initial sync (~2,900 events/site, under a minute).

**Verify everything is up:**

```bash
curl -s http://localhost:8100/health          # {"ok":true,...,"providers":["deepseek",...]}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login     # 200
curl -s -X POST http://localhost:4100/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@dental.dev","password":"dental-demo"}' | head -c 60  # {"token":...
```

## 4. Sign in — demo credentials

All passwords: **`dental-demo`**

| User | Role | What they see |
|---|---|---|
| `admin@dental.dev` | admin (org-wide) | everything: dashboard, analytics, billing, audit, admin pages |
| `frontdesk@dental.dev` | staff (pinned to Austin) | schedule, patients, approvals, tasks, comms — no billing/analytics/audit |
| `drpatel@dental.dev` | provider (Austin, linked to DDS1) | **only her own** schedule/patients (~138 of 300); no dollar amounts |
| `billing@dental.dev` | billing (org-wide) | claims, denials, pre-auths, payments, eligibility; no campaign triggers |

| Surface | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Temporal UI | http://localhost:8233 |
| Agents API docs | http://localhost:8100/docs |
| Hosted demo | https://dental-ai-platform.vercel.app (see §8) |

Handy aliases used below:

```bash
alias odsql='docker exec -i dental-opendental-a mysql -uod -podpass opendental -e'
alias pg='docker exec dental-postgres psql -U dental -d dental -c'
```

> ⚠️ The login rate limiter counts **all** attempts (10 / 5 min / IP) — scripted test
> loops that log in repeatedly will hit 429.

---

## 5. Feature test walkthroughs

### T1 — Login, roles, location switching
1. `admin@dental.dev` → full sidebar, location switcher flips Austin ↔ Round Rock (all KPIs change).
2. `frontdesk@dental.dev` → pinned to Austin; Billing/Analytics/Audit links absent; direct URLs show a role-gate notice.
3. `drpatel@dental.dev` → Schedule shows only DDS1's column; foreign charts 403; overview hides dollars.
4. `billing@dental.dev` → billing worklists org-wide; campaign triggers and the SMS simulator are refused.

### T2 — Live PMS sync (edge → cloud)
```bash
odsql "UPDATE patient SET WirelessPhone='(512) 555-0142' WHERE PatNum=1;"
```
Within ~5s the new number is in Postgres (`pg "SELECT wireless_phone, synced_at FROM patients WHERE location_id=1 AND source_id=1;"`) and the chart shows fresh "synced" provenance.

### T3 — Flagship loop: cancellation → agent → approval → SMS → booked write-back
1. Find a future appointment: `odsql "SELECT AptNum FROM appointment WHERE AptStatus=1 AND AptDateTime > NOW() + INTERVAL 1 DAY LIMIT 3;"`
2. Cancel it **inside OpenDental**: `odsql "UPDATE appointment SET AptStatus=5 WHERE AptNum=<AptNum>;"`
3. ~10s later an approval card appears in **Approvals** (agent-chosen overdue patient + drafted SMS); Temporal UI shows `backfill-a-<AptNum>` running, parked on the approval signal.
4. **Approve** → the text appears in **SMS Console**.
5. Reply `YES` as that patient in the console.
6. ~10s later: confirmation SMS, card `executed`, workflow complete, and the booking exists in OpenDental (`odsql "SELECT AptNum, Note FROM appointment ORDER BY AptNum DESC LIMIT 1;"` → *Booked by AI scheduling agent…*).

Variations: reply `NO` (polite decline, card `rejected`); reject the card (no SMS sent).

### T4 — Recall campaign
Overview → **Run recall campaign** → batch approval card → Approve → 5 rate-limited texts land ~2s apart → card `executed`. (Patients who texted STOP are silently skipped — that's E1 policy, not a bug.)

### T5 — Claim follow-up (durable payer polling)
Overview → **Run claim follow-up** → card shows the agent's pick + drafted letter → Approve → letter is written back to the chart **inside OpenDental** (AddCommlog), then the workflow polls the mock clearinghouse every 15s until `paid` or escalates a `claim_escalation` card. Watch `claimfu-a-…` in the Temporal UI.

### T6 — Clinical pre-visit summary (grounded RAG)
Patients → open anyone with history → **Generate pre-visit summary**. First run embeds all notes (downloads the local embedding model once, ~30s). With an LLM key: bullets citing `[note <id>]`; without: a labelled deterministic digest. Each generation writes a PHI audit entry (`agent:clinical`).

### T7 — Semantic chart search (pgvector)
Patients page → "ask the charts": try `root canal with lingering pain`, `crown prep with sensitivity`, `heavy calculus deep pockets` → ranked matches with similarity %, even when those exact words never appear in a note. Provider accounts only get hits from their own patients.

### T8 — PHI audit trail + tamper-evident chain (G2)
Audit page (admin): every action above appears with actor badge (user/agent/edge) and purpose. Click **Verify chain** → `ok` + rows checked. Prove tamper evidence:
```bash
pg "UPDATE audit_log SET purpose='tampered' WHERE id=(SELECT max(id)-5 FROM audit_log);"
```
→ Verify now reports the broken row. (Restore from backup or accept the break in a throwaway DB — never UPDATE audit_log outside this test.) The nightly `audit-chain-verify` cron files an urgent task on breaks.

### T9 — Tenancy & RBAC (API level)
```bash
FD=$(curl -s -X POST http://localhost:4100/auth/login -H 'content-type: application/json' \
  -d '{"email":"frontdesk@dental.dev","password":"dental-demo"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -o /dev/null -w "cross-site:   %{http_code}\n" "http://localhost:4100/portal/overview?locationId=2" -H "authorization: Bearer $FD"   # 403
curl -s -o /dev/null -w "audit(staff): %{http_code}\n" "http://localhost:4100/portal/audit" -H "authorization: Bearer $FD"                   # 403
curl -s -o /dev/null -w "own site:     %{http_code}\n" "http://localhost:4100/portal/overview?locationId=1" -H "authorization: Bearer $FD"   # 200
```
The full role→permission matrix is asserted by `apps/api/src/auth/roles.test.ts`.

### T10 — Crash resilience
Kill the site-A edge worker mid-flight (`pkill -f "EDGE_SITE=a"`), make MySQL changes and/or leave a `BookAppointment` command pending, restart → it resumes from persisted cursors, re-delivers (server dedups), and applies the pending command **exactly once**.

### T11 — Automated tests
```bash
pnpm test          # 133 API tests (RBAC, provider scope, policy, audit chain, …) + 16 edge contract tests
pnpm typecheck     # strict TS across all 12 packages
cd apps/agents && uv run pytest    # Python agent tests
```

### T12 — LLM provider chain
`curl -s http://localhost:8100/health` → `providers: ["deepseek","anthropic"]` (both keys), `["anthropic"]`, or `[]` (all agents use deterministic fallbacks; responses report `usedLlm:false`). Restart the agents process after editing `.env`.

### T13 — SSO (OIDC, local dev IdP)
Two prerequisites, or the button fails: the **dev IdP must be running** (otherwise the
flow bounces back with `#error=idp_unreachable`), and the **dental web app must be the
thing on :3000** (the SSO callback redirects the browser to `WEB_URL/login/sso` — if
another project's dev server occupies port 3000 you get that app's 404 page instead).

```bash
node tools/dev-idp/server.mjs      # OIDC provider on :9400 (matches .env defaults)
```
Open http://localhost:3000/login → **Continue with Dev IdP** → sign in as
`admin@dental.dev` → dashboard via verified ID token; audit shows `auth.sso.login`.
Negative: `stranger@nowhere.dev` is rejected (flip `OIDC_AUTO_PROVISION=true` to watch
a staff user get created). Production IdPs: point `OIDC_*` at Google/Okta/Azure AD,
redirect URI `<API_URL>/auth/sso/callback`.

Headless verification (the dev IdP supports `&auto=1&email=`):
```bash
AUTH_URL=$(curl -s -i -c /tmp/sso.txt "http://localhost:4100/auth/sso/login" | grep -i "^location:" | tr -d '\r' | cut -d' ' -f2)
CB_URL=$(curl -s -i "${AUTH_URL}&auto=1&email=admin@dental.dev" | grep -i "^location:" | tr -d '\r' | cut -d' ' -f2)
curl -s -i -b /tmp/sso.txt -c /tmp/sso.txt "$CB_URL" | grep -i location    # → :3000/login/sso#sso=ok
curl -s -b /tmp/sso.txt http://localhost:4100/auth/me                      # → admin session JSON
```
Note: SSO with the dev IdP is a **local-machine** demo — the IdP and the redirect
target are localhost. The login page detects this (`issuerIsLocal` on
`GET /auth/sso/status`) and **automatically hides the SSO button on hosted deploys**;
it reappears only if `OIDC_*` points at a real, publicly reachable IdP
(Google/Okta/Azure AD). On the hosted Vercel URL, use password login.

### T14 — Real Twilio SMS
Requires **all three** of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` in `.env` (with any missing, everything transparently uses the console simulator).
1. Set the three values; set a patient's `WirelessPhone` to your cell (T2 syncs it); restart the API.
2. Run T3 → on approval the text arrives on your phone; the console row shows `twilio queued/sent/delivered`.
3. Inbound: expose the API via a tunnel (`cloudflared tunnel --url http://localhost:4100` — see §8), set `TWILIO_WEBHOOK_BASE_URL=<tunnel URL>`, restart the API, and point the Twilio number's messaging webhook at `<tunnel>/twilio/sms` (Console → Phone Numbers → Active numbers → the number → Messaging → "A message comes in"). Replies thread into workflows exactly like console replies. Status callbacks reconcile via `<tunnel>/twilio/status` automatically when the base URL is https.
4. **Trial-account caveats**: Twilio trials deliver only to phone numbers verified in the Console, prefix every text with "Sent from your Twilio trial account", and may restrict the number-management API (webhook must be set in the Console UI, not via API). Synthetic seed patients have fake numbers — put **your own verified cell** on the test patient or deliveries will fail.

### T15 — Insurance eligibility (B2)
Billing → **Run eligibility sweep** (or the 05:00 cron). Green/amber/red **Ins.** dots appear on `/schedule` rows; failures land as `eligibility_failure` tasks. The mock payer is deterministic (`pg "SELECT status, count(*) FROM eligibility_checks GROUP BY status;"`). Booking a new appointment within 3 days auto-starts a targeted check (`elig-a-<AptNum>` in Temporal).

### T16 — Pre-authorization lifecycle (B3)
```bash
pnpm simulate preauth-crown --site a
```
→ `preauth_submission` approval card (narrative cites note ids) → Approve → Billing shows `submitted` + payer ref; workflow polls. Outcomes are deterministic per procedure: approved → chart commlog; denied → high-priority task; more-info → a `preauth_required` task names the missing item — resolve it in /tasks and the parked workflow resumes.

### T17 — Denial classification + appeal (B4)
```bash
pnpm simulate denial-storm --site a
```
Follow up a denied claim from Billing → approve → workflow hits the denial, classifies the CARC (16/96/50/197 appealable; 45/97/119 not) → appealable: appeal card → Approve → letter written back to chart, workflow polls to won/lost. Audit shows the full chain `denial.classified → agent.proposed.claim_appeal → approval.approved → appeal.sent → appeal.won|lost`.

### T18 — Billing worklist reconciliation (B5) + payments ledger (G3)
Billing tiles must reconcile with canonical SQL:
```bash
pg "SELECT count(*), round(sum(claim_fee - ins_pay_amt)) FROM claims WHERE location_id=1 AND status IN ('sent','waiting');"
```
Claims ranked by `age + fee/100 + denied×40 + preauthBlocked×25` (hover the priority number). Payments ledger bounds `pay_date` to today — the seeder intentionally creates some future-dated payments that appear over time.

### T19 — Morning huddle (C1)
Overview → **Generate digest** (or 06:00 cron): narrative + ≤5 ranked, role-tagged action items; one-click "→ task"; **Email me** sends the digest via the email channel. Provider/staff see it; billing role doesn't run huddles.

### T20 — Reminders + confirmation write-back (C2)
Overview → **Run reminder sweep** (or 16:00 cron): tomorrow's unconfirmed appointments → batch approval (skipped for locations with `autoSendReminders` on — Admin → Locations toggles it) → texts → reply `C` or `YES` → the appointment is marked **Confirmed inside OpenDental** via edge command. Note: weekends have no seeded appointments, so a Friday sweep honestly reports nothing for Saturday.

### T21 — Reschedule conversation + waitlist cascade (C3)
In the SMS console, text `CHANGE` as any patient with an upcoming appointment → the deterministic slot-offer conversation starts (numbered slot menu) → reply a number → the reschedule is booked via edge commands. The T3 cascade also walks multiple candidates: if the first doesn't reply within the window, the next is texted.

### T22 — No-show risk (C4)
Schedule rows carry a risk badge (hover = factor trail: prior no-shows, lead time, recall overdue…). Scored during the morning huddle; patients with ≥2 prior no-shows are deprioritized by the backfill agent.

### T23 — Unscheduled-treatment outreach (C5)
Billing → unscheduled list, or Overview → **Run treatment outreach** (or 07:00 cron): agent ranks the backlog by value/urgency → approval → texts; each YES spawns a detached reschedule conversation to actually book the patient.

### T24 — Analytics + owner insights (D2/D3)
As org-wide admin: `/analytics` — cross-location table flags worst-in-column (cells deep-link into Billing), trend grids per metric, day toggle. "Ask about performance" answers natural-language questions over the rollups (LLM badge vs deterministic). `/dashboard` — clinic cards with sparklines and health flags; click into drill-down trends vs org average. "Recompute rollups" (admin-only; `days>1` backfill is deliberately admin-gated because it overwrites metric history).

### T25 — Consent, quiet hours, frequency caps (E1)
- Text `STOP` as a patient → sticky opt-out (audit `sms.opted_out`); future campaign sends show `blocked_consent` in the console. (Demo DB already has patients 19 & 277 opted out.)
- Outreach outside 08:00–20:00 patient-local is **queued** with a visible `send_after` and flushed by the 30s outbox — never dropped.
- Caps: 2/day, 6/week per patient (outreach only); excess shows `blocked_frequency`.

### T26 — Inbound intent router (E2)
Text something free-form as a patient ("how much do I owe?") → no auto-reply; a `patient_question` task appears in /tasks with the classified intent + an editable suggested reply. A human edits/sends it (policy-gated as `conversation`).

### T27 — Email channel (E3)
Patients with `preferred_channel=email` (152 seeded on site A) receive campaign messages on the **Email** tab of the console instead of SMS. Patient detail → **Email statement** sends a versioned-template balance notice. Set `SMTP_URL`/`EMAIL_FROM` for real delivery.

### T28 — Realtime (F1)
Keep the dashboard open while running T3: the notification bell updates via SSE (no refresh) — approval created, task created, workflow milestones. Deep links per event type; unread count per location.

### T29 — MFA (F2)
Account page → enroll TOTP (QR + authenticator app) → sign out/in → 6-digit challenge; recovery codes work once each. `MFA_ENFORCE_ADMIN=true` forces admin enrollment at login (default in production).

### T30 — Admin: users & locations (F3/G1)
`/admin/users`: invite (temp password shown once), change role/location/provider link (provider role **requires** a location + provider link — the API refuses otherwise), disable (session dies ≤30s), reset password/MFA. `/admin/locations`: timezone (drives quiet hours) + auto-send-reminders.

### T31 — PMS adapter modes + fallback (A1)
Run an edge in API mode against the mock OD server, or watch fallback: stop site A's MySQL container → after 3 failed health checks with `PMS_FALLBACK=mock`, the edge hot-swaps to the simulator and the header badge shows **degraded**; restart MySQL → back to live.
```bash
pnpm --filter @dental/mock-od-api dev     # OD-REST fixture on :8388
PMS_MODE_A=api pnpm --filter @dental/edge-sync dev:a
```

### T32 — Live practice simulator (A2)
```bash
pnpm simulate live --site a --speed 5     # continuous bookings/cancellations/walk-ins/payments
pnpm simulate flagship-loop --site a      # scripted T3 trigger
```

---

## 6. Stop / reset

```bash
docker compose down          # stop infra (keeps data volumes)
docker compose down -v       # ⚠ full reset — wipes both MySQLs and Postgres
pnpm seed && rm -rf edge-sync-state    # reseed practices + clear edge cursors
# full reset after down -v: redo setup steps 3–5
```

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` hangs silently | remove `"credsStore"` from `~/.docker/config.json` |
| API dies `EADDRINUSE :4100` | `lsof -ti:4100 \| xargs kill -9` and restart |
| Approval card never appears (T3) | appointment must be *future* and previously synced `scheduled`; check both edge workers + API log + Temporal UI |
| Workflows never start / tasks time out | Temporal container unhealthy, `TEMPORAL_DISABLED=1`, or the in-process worker died on a hot-reload — cleanly restart the API |
| SMS reply doesn't advance workflow | reply must come from the patient the outreach targeted |
| Previsit/search 400s or hangs | agents not on :8100, or first-run embedding-model download in progress |
| A campaign "skips" some patients | E1 policy working: STOP opt-outs, quiet hours (queued), or frequency caps — the console shows the typed reason |
| 429 on login | rate limiter (10/5min/IP, successes count) — wait out the window |
| localhost:3000 shows a **different app** (wrong nav, dark theme, pages with no sign-in) | another project's dev server is squatting on port 3000 — the dental web app isn't running. Find it with `lsof -nP -iTCP:3000 -sTCP:LISTEN`, kill it, then `pnpm --filter @dental/web dev`. Every dental page is behind the cookie session; if you can browse "pages" without signing in, you are not looking at this app |
| Login says **Invalid credentials** for known-good `dental-demo` (or API responses look odd, e.g. `{"code":"not_found"}`) | another project's API is squatting on **port 4100** — the login is hitting the wrong backend (this also breaks the hosted Vercel site, whose tunnel targets :4100). `lsof -nP -iTCP:4100 -sTCP:LISTEN` → if the command's cwd isn't this repo, kill it and restart `pnpm --filter @dental/api dev`. Other projects on this machine (Caseline, Healthcare Notes) default to the same 3000/4100 ports — don't run their dev stacks during a dental demo |
| SSO button → black 404 page or `#error=idp_unreachable` | the dev IdP isn't running (`node tools/dev-idp/server.mjs`), and/or port 3000 is occupied by another app so the `WEB_URL/login/sso` redirect lands in the wrong project (see row above) |

---

## 8. Production deployment (Vercel + Railway + Neon)

The platform runs **fully in the cloud** — no local machine required
(topology in ARCHITECTURE.md §12):

| Piece | Where | Notes |
|---|---|---|
| Web | Vercel — https://dental-ai-platform.vercel.app | proxies `/backend/*` to the API |
| API + Temporal worker | Railway `api` — https://api-production-f9f2.up.railway.app | Twilio webhooks land here (stable URL) |
| AI agents | Railway `agents` (private, IPv6 :8100) | embedding model baked into the image |
| Temporal server | Railway `temporal` (`temporalio/auto-setup`) | persistence on the dedicated Railway `Postgres` — NOT Neon |
| Edge workers ×2 | Railway `edge-a` / `edge-b`, `PMS_MODE=mock` | the practice simulator is the cloud PMS; generates live activity + applies write-backs |
| Platform DB | Neon (`neon-yellow-kite`, via Vercel Marketplace) | canonical data, pgvector embeddings, audit chain |

Same demo credentials as §4. All 11 Temporal crons registered; the simulator keeps
the practices "alive" (bookings, cancellations, claims), so approvals/tasks/SMS
console keep moving on their own.

### Operating it

```bash
railway status / railway logs --service <api|agents|temporal|edge-a|edge-b>
railway redeploy --service api -y          # restart a service
railway up --service api --detach          # deploy current working tree (run from repo root)
cd apps/web && vercel deploy --prod --yes  # redeploy the frontend
```

Gotchas discovered while standing this up (already handled, but relevant when touching it):
- Railway archives from the **repo root** — all three Dockerfiles use root context.
- Railway private networking is **IPv6-only** — services bind `::`.
- Docker `VOLUME` is unsupported — edge state is ephemeral (safe: re-capture + dedup).
- Edge API keys must match `locations.edge_api_key` **in the DB**, not just env.
- Temporal persistence needs a real Postgres (Railway `Postgres` service); Neon's
  serverless compute caused chronic `context deadline exceeded`.
- After Temporal's store is reset, `railway redeploy --service api` re-registers crons.

### Twilio (one-time, now that the URL is stable)
Point the number's **"A message comes in"** webhook (Console → Phone Numbers →
+1 312 483 0370 → Messaging) at:
`https://api-production-f9f2.up.railway.app/twilio/sms` — status callbacks reconcile
automatically. Trial-account caveats in T14 still apply.

### Verified end-to-end in production (2026-07-16)
Hosted login + cookie session (201) and authenticated reads through Railway; both mock
edges syncing (`pushed 200 events, accepted 200`) with live heartbeats; semantic chart
search over 1,252 freshly rebuilt embeddings; `morningHuddle` Temporal workflow ran
end-to-end (LLM narrative persisted and served); `preAuthorization` workflows started
automatically from simulator activity via ingest hooks.
