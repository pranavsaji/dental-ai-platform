# F4 — AWS deployment path

Staged so each step is independently shippable. **Stage 1 is checked in as
Terraform under `terraform/`; stages 2–5 are design notes.** Nothing here is
required for the local demo — the platform runs fully mock-first on a laptop.

## Stage 1 — Terraform baseline (`terraform/`)

What it provisions:

| Concern | Resource | Notes |
|---|---|---|
| Network | VPC, 2×public + 2×private subnets, 1 NAT | ALB public; services/DB private |
| Database | Aurora PostgreSQL 16 cluster | pgvector via `CREATE EXTENSION` in bootstrap; KMS-encrypted, 14-day backups, deletion protection |
| Compute | ECS Fargate: `api`, `web`, `agents` | api runs the in-process Temporal worker, same topology as dev |
| Ingress | ALB | `/auth/*`, `/portal/*`, `/edge/*`, `/twilio/*` → api; everything else → web. Same-origin in prod, so the F2 session cookies are first-party |
| Secrets | Secrets Manager + customer-managed KMS key | replaces `.env`; third-party keys (DeepSeek, Twilio, SMTP) are set out-of-band so Terraform state never holds them |
| Logs | CloudWatch log group (KMS-encrypted, 90-day retention) | Container Insights on |

Usage (once an account/backend exists):

```bash
cd infra/terraform
terraform init          # switch backend to S3+DynamoDB first
terraform plan -var 'app_images={api="…",web="…",agents="…"}'
```

Images come from the F2 Dockerfiles (`apps/*/Dockerfile`), pushed to ECR by CI.
Status: **design artifact — reviewed HCL, not yet applied against an account**
(no terraform binary/account in the dev environment; `terraform validate` is
the first step of a real rollout).

## Stage 2 — Temporal

Managed **Temporal Cloud** (`var.temporal_address` + mTLS client cert in
Secrets Manager). The worker stays in-process in the api service until
workflow volume justifies a dedicated `worker` ECS service — the split is
config, not code: the worker half of `TemporalService` moves behind
`TEMPORAL_WORKER=standalone`.

## Stage 3 — Edge distribution

The edge synchronizer is already containerized (`apps/edge-sync/Dockerfile`).
On-prem shape: that container (or a signed installer wrapping it) pinned per
release channel, holding only its site key; mTLS to the ingest endpoint
(client certs issued per site, rotated via the auto-update channel). The edge
never accepts inbound connections — the OD-API webhook listener stays
loopback/LAN-only.

## Stage 4 — Observability

OpenTelemetry traces across the seam that matters: edge tick → `/edge/ingest`
→ hook → Temporal workflow → agent call. CloudWatch dashboards per location
for sync lag (`locations.last_heartbeat_at` age), workflow failure rate, and
outbox depth; alarms on sync-lag > 5 min (matches the `sync.lagging`
notification the UI already shows) and any workflow task timeout.

## Stage 5 — BAA chain

Per `compliance/baa-readiness.md`: AWS BAA (all stage-1 services are
HIPAA-eligible), Twilio BAA, and the LLM provider. Until a BAA-capable LLM
provider is signed, the F2 prompt de-identification layer
(`apps/agents/app/deid.py` — names/phones/emails tokenized before every call,
rehydrated after) is the operating mitigation for the DeepSeek-in-PHI-path
blocker.
