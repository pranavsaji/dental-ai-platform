import {
  pgTable, bigserial, bigint, text, timestamp, date, boolean, integer,
  doublePrecision, jsonb, uniqueIndex, index, vector
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Tenancy. org -> locations; every domain row carries orgId + locationId.
// Canonical records from the PMS are keyed (locationId, sourceId) where
// sourceId is the OpenDental *Num primary key at that site.
// ---------------------------------------------------------------------------

export const orgs = pgTable("orgs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const locations = pgTable("locations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull().references(() => orgs.id),
  key: text("key").notNull(), // 'a' | 'b' — matches the edge site key
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Chicago"),
  edgeApiKey: text("edge_api_key").notNull(),
  // Integration provenance (A1): what the edge reports via /edge/heartbeat.
  // Keeps the dashboard honest about whether data is live PMS or mock.
  integrationMode: text("integration_mode").notNull().default("unknown"), // api | mysql | mock | unknown
  integrationStatus: text("integration_status").notNull().default("unknown"), // live | degraded | stale | unknown
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  // C2: first policy-driven auto-send. False = reminder batches park on an
  // approval card; true = the nightly sweep sends without a human gate.
  autoSendReminders: boolean("auto_send_reminders").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex("locations_key_uq").on(t.key)]);

export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull().references(() => orgs.id),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(), // 'admin' | 'provider' | 'staff'
  // null = all locations in org; set = restricted to one location
  locationId: bigint("location_id", { mode: "number" }),
  // scrypt salt:hash; null for SSO-only accounts (no password login)
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex("users_email_uq").on(t.email)]);

// Federated identities (OIDC SSO). A user may hold both a password and one or
// more linked identities; lookup key is (issuer, subject) from the ID token.
export const authIdentities = pgTable("auth_identities", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  email: text("email").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true })
}, (t) => [uniqueIndex("authid_iss_sub_uq").on(t.issuer, t.subject)]);

// --- canonical PMS mirrors ---------------------------------------------------

const tenantCols = {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  sourceStamp: timestamp("source_stamp", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow()
};

export const providers = pgTable("providers", {
  ...tenantCols,
  abbr: text("abbr").notNull(),
  lastName: text("last_name").notNull(),
  firstName: text("first_name").notNull(),
  specialty: integer("specialty").notNull(),
  isHidden: boolean("is_hidden").notNull().default(false)
}, (t) => [uniqueIndex("providers_loc_src_uq").on(t.locationId, t.sourceId)]);

export const operatories = pgTable("operatories", {
  ...tenantCols,
  name: text("name").notNull(),
  abbrev: text("abbrev").notNull(),
  itemOrder: integer("item_order").notNull(),
  defaultProviderSourceId: bigint("default_provider_source_id", { mode: "number" }).notNull(),
  isHidden: boolean("is_hidden").notNull().default(false)
}, (t) => [uniqueIndex("operatories_loc_src_uq").on(t.locationId, t.sourceId)]);

export const procedureCodes = pgTable("procedure_codes", {
  ...tenantCols,
  procCode: text("proc_code").notNull(),
  description: text("description").notNull(),
  abbrDesc: text("abbr_desc").notNull(),
  // B3: derived at ingest from requiresPreauth() in @dental/shared — the
  // shared helper is the source of truth, this column is its queryable mirror.
  requiresPreauth: boolean("requires_preauth").notNull().default(false)
}, (t) => [uniqueIndex("proccodes_loc_src_uq").on(t.locationId, t.sourceId)]);

export const patients = pgTable("patients", {
  ...tenantCols,
  lastName: text("last_name").notNull(),
  firstName: text("first_name").notNull(),
  birthdate: date("birthdate"),
  gender: text("gender").notNull(),
  status: text("status").notNull(),
  homePhone: text("home_phone").notNull().default(""),
  wirelessPhone: text("wireless_phone").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  primaryProviderSourceId: bigint("primary_provider_source_id", { mode: "number" }).notNull(),
  firstVisit: date("first_visit")
}, (t) => [
  uniqueIndex("patients_loc_src_uq").on(t.locationId, t.sourceId),
  index("patients_org_idx").on(t.orgId),
  index("patients_name_idx").on(t.lastName, t.firstName)
]);

export const appointments = pgTable("appointments", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  status: text("status").notNull(), // scheduled | complete | unscheduled | broken | planned
  startsAt: timestamp("starts_at").notNull(),
  minutes: integer("minutes").notNull(),
  confirmed: boolean("confirmed").notNull().default(false),
  operatorySourceId: bigint("operatory_source_id", { mode: "number" }).notNull(),
  providerSourceId: bigint("provider_source_id", { mode: "number" }).notNull(),
  note: text("note").notNull().default(""),
  procDescript: text("proc_descript").notNull().default(""),
  // No-show risk (C4): stamped by the nightly sweep from computeNoShowRisk()
  // in @dental/shared. factors is the explanation trail shown in the UI.
  noShowRisk: doublePrecision("no_show_risk").notNull().default(0),
  noShowFactors: jsonb("no_show_factors").notNull().default([])
}, (t) => [
  uniqueIndex("appointments_loc_src_uq").on(t.locationId, t.sourceId),
  index("appointments_starts_idx").on(t.locationId, t.startsAt),
  index("appointments_pat_idx").on(t.locationId, t.patientSourceId)
]);

export const procedures = pgTable("procedures", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  appointmentSourceId: bigint("appointment_source_id", { mode: "number" }).notNull(),
  procDate: date("proc_date"),
  fee: doublePrecision("fee").notNull(),
  status: text("status").notNull(), // planned | complete | deleted | other
  providerSourceId: bigint("provider_source_id", { mode: "number" }).notNull(),
  codeSourceId: bigint("code_source_id", { mode: "number" }).notNull(),
  toothNum: text("tooth_num").notNull().default(""),
  surface: text("surface").notNull().default("")
}, (t) => [
  uniqueIndex("procedures_loc_src_uq").on(t.locationId, t.sourceId),
  index("procedures_pat_idx").on(t.locationId, t.patientSourceId)
]);

export const insPlans = pgTable("ins_plans", {
  ...tenantCols,
  groupName: text("group_name").notNull(),
  groupNum: text("group_num").notNull(),
  carrierName: text("carrier_name").notNull(),
  planType: text("plan_type").notNull(),
  carrierPhone: text("carrier_phone").notNull().default(""),
  payerId: text("payer_id").notNull().default(""),
  annualMax: doublePrecision("annual_max").notNull().default(0),
  deductible: doublePrecision("deductible").notNull().default(0)
}, (t) => [uniqueIndex("insplans_loc_src_uq").on(t.locationId, t.sourceId)]);

export const patPlans = pgTable("pat_plans", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  planSourceId: bigint("plan_source_id", { mode: "number" }).notNull(),
  ordinal: integer("ordinal").notNull(),
  subscriberId: text("subscriber_id").notNull()
}, (t) => [uniqueIndex("patplans_loc_src_uq").on(t.locationId, t.sourceId)]);

export const claims = pgTable("claims", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  dateService: date("date_service"),
  dateSent: date("date_sent"),
  status: text("status").notNull(), // unsent | hold | waiting | sent | received
  claimFee: doublePrecision("claim_fee").notNull(),
  insPayEst: doublePrecision("ins_pay_est").notNull(),
  insPayAmt: doublePrecision("ins_pay_amt").notNull(),
  planSourceId: bigint("plan_source_id", { mode: "number" }).notNull(),
  providerSourceId: bigint("provider_source_id", { mode: "number" }).notNull(),
  note: text("note").notNull().default(""),
  // Comma-joined CARC codes when denied ("16,97"); "" otherwise. Denial state
  // derives from this — OD claim statuses have no 'denied' letter.
  carcCodes: text("carc_codes").notNull().default("")
}, (t) => [
  uniqueIndex("claims_loc_src_uq").on(t.locationId, t.sourceId),
  index("claims_status_idx").on(t.locationId, t.status)
]);

export const claimProcs = pgTable("claim_procs", {
  ...tenantCols,
  claimSourceId: bigint("claim_source_id", { mode: "number" }).notNull(),
  procedureSourceId: bigint("procedure_source_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  planSourceId: bigint("plan_source_id", { mode: "number" }).notNull(),
  received: boolean("received").notNull(),
  feeBilled: doublePrecision("fee_billed").notNull(),
  insPayEst: doublePrecision("ins_pay_est").notNull(),
  insPayAmt: doublePrecision("ins_pay_amt").notNull(),
  writeOff: doublePrecision("write_off").notNull()
}, (t) => [uniqueIndex("claimprocs_loc_src_uq").on(t.locationId, t.sourceId)]);

export const recalls = pgTable("recalls", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  dateDue: date("date_due"),
  datePrevious: date("date_previous"),
  isDisabled: boolean("is_disabled").notNull().default(false)
}, (t) => [
  uniqueIndex("recalls_loc_src_uq").on(t.locationId, t.sourceId),
  index("recalls_due_idx").on(t.locationId, t.dateDue)
]);

export const commLogs = pgTable("comm_logs", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  happenedAt: timestamp("happened_at").notNull(),
  commType: integer("comm_type").notNull(),
  note: text("note").notNull(),
  mode: integer("mode").notNull(),
  sentOrReceived: integer("sent_or_received").notNull()
}, (t) => [
  uniqueIndex("commlogs_loc_src_uq").on(t.locationId, t.sourceId),
  index("commlogs_pat_idx").on(t.locationId, t.patientSourceId)
]);

// Payments (A4): the 13th mirrored entity — collections, AR, and
// production-vs-collections metrics all read from here.
export const payments = pgTable("payments", {
  ...tenantCols,
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  payDate: date("pay_date"),
  amount: doublePrecision("amount").notNull(),
  payType: integer("pay_type").notNull(), // sim: 1 check, 2 card, 3 cash, 4 insurance EFT
  note: text("note").notNull().default("")
}, (t) => [
  uniqueIndex("payments_loc_src_uq").on(t.locationId, t.sourceId),
  index("payments_date_idx").on(t.locationId, t.payDate),
  index("payments_pat_idx").on(t.locationId, t.patientSourceId)
]);

// --- sync plumbing -----------------------------------------------------------

export const syncEvents = pgTable("sync_events", {
  eventId: text("event_id").primaryKey(), // dedup key from the edge
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  tableName: text("table_name").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow()
});

export const edgeCommands = pgTable("edge_commands", {
  commandId: text("command_id").primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | delivered | applied | failed
  resultSourceId: bigint("result_source_id", { mode: "number" }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("edgecmd_loc_status_idx").on(t.locationId, t.status)]);

// --- platform features ---------------------------------------------------------

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }),
  actorType: text("actor_type").notNull(), // user | agent | edge | system
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  resourceId: text("resource_id").notNull().default(""),
  purpose: text("purpose").notNull().default(""),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("audit_org_at_idx").on(t.orgId, t.at)]);

export const proposedActions = pgTable("proposed_actions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  workflowId: text("workflow_id").notNull(),
  agent: text("agent").notNull(), // scheduling | billing | clinical
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | executed | expired
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("proposed_org_status_idx").on(t.orgId, t.status)]);

export const smsMessages = pgTable("sms_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  direction: text("direction").notNull(), // outbound | inbound
  body: text("body").notNull(),
  workflowId: text("workflow_id"),
  // Delivery via the pluggable SMS gateway: 'console' rows are simulated,
  // 'twilio' rows carry the Message SID and carrier status callbacks.
  provider: text("provider").notNull().default("console"), // console | twilio
  toNumber: text("to_number").notNull().default(""),
  providerSid: text("provider_sid"),
  status: text("status").notNull().default("recorded"), // recorded | queued | sent | delivered | undelivered | failed
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("sms_loc_pat_idx").on(t.locationId, t.patientSourceId),
  index("sms_provider_sid_idx").on(t.providerSid)
]);

// Task management substrate (A5): the durable, assignable work queue every
// workflow dead-end escalates into. Built once, consumed by B/C/E features.
export const tasks = pgTable("tasks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  type: text("type").notNull(), // eligibility_failure | claim_denial | patient_question | huddle_action | preauth_required | manual | ...
  title: text("title").notNull(),
  body: text("body").notNull().default(""), // may embed an agent-drafted suggested reply/action
  priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
  status: text("status").notNull().default("open"), // open | in_progress | done | dismissed
  assigneeRole: text("assignee_role"), // admin | provider | staff | null = pool
  assigneeUserId: bigint("assignee_user_id", { mode: "number" }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  createdBy: text("created_by").notNull(), // user email | agent:<name> | workflow
  workflowId: text("workflow_id"),
  // Deep link into the record the task is about (claim, patient, appointment…)
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by")
}, (t) => [
  index("tasks_loc_status_idx").on(t.locationId, t.status),
  index("tasks_org_status_idx").on(t.orgId, t.status)
]);

// Patient contact preferences (A3/E1): mirrored from PMS consent flags at
// ingest; STOP replies and staff edits update it platform-side. E1's policy
// engine reads exactly this table before any message leaves the platform.
export const patientContactPrefs = pgTable("patient_contact_prefs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  smsConsent: boolean("sms_consent").notNull().default(true),
  emailConsent: boolean("email_consent").notNull().default(true),
  preferredChannel: text("preferred_channel").notNull().default("sms"), // sms | email | phone
  timezone: text("timezone").notNull().default("America/Chicago"),
  consentSource: text("consent_source").notNull().default("pms_mirror"),
  optOutAt: timestamp("opt_out_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex("contactprefs_loc_pat_uq").on(t.locationId, t.patientSourceId)]);

// Daily metrics rollups (D1 computes these nightly; the A3 bootstrap seeds 90
// days of history so analytics render on day one). Explicit rows, not a
// matview — testable, incrementally backfillable, history preserved.
export const dailyLocationMetrics = pgTable("daily_location_metrics", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  date: date("date").notNull(),
  productionScheduled: doublePrecision("production_scheduled").notNull().default(0),
  productionCompleted: doublePrecision("production_completed").notNull().default(0),
  collections: doublePrecision("collections").notNull().default(0),
  cancellationCount: integer("cancellation_count").notNull().default(0),
  noshowCount: integer("noshow_count").notNull().default(0),
  brokenRate: doublePrecision("broken_rate").notNull().default(0),
  hygieneReappointmentRate: doublePrecision("hygiene_reappointment_rate").notNull().default(0),
  unscheduledTreatmentValue: doublePrecision("unscheduled_treatment_value").notNull().default(0),
  ar0_30: doublePrecision("ar_0_30").notNull().default(0),
  ar31_60: doublePrecision("ar_31_60").notNull().default(0),
  ar61_90: doublePrecision("ar_61_90").notNull().default(0),
  ar90Plus: doublePrecision("ar_90_plus").notNull().default(0),
  openClaimsValue: doublePrecision("open_claims_value").notNull().default(0),
  denialCount: integer("denial_count").notNull().default(0),
  newPatients: integer("new_patients").notNull().default(0),
  caseAcceptanceRate: doublePrecision("case_acceptance_rate").notNull().default(0),
  appointmentsCount: integer("appointments_count").notNull().default(0),
  chairUtilization: doublePrecision("chair_utilization").notNull().default(0)
}, (t) => [uniqueIndex("dlm_loc_date_uq").on(t.locationId, t.date)]);

// --- Phase B: billing suite ----------------------------------------------------

// Eligibility verification results (B2). One row per check — history is kept;
// readers take the freshest row per (patient, plan). Checks are fresh for 30
// days (expiresAt); the nightly sweep skips patients with a live check.
export const eligibilityChecks = pgTable("eligibility_checks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  planSourceId: bigint("plan_source_id", { mode: "number" }).notNull(),
  appointmentSourceId: bigint("appointment_source_id", { mode: "number" }),
  status: text("status").notNull(), // verified | inactive | attention | failed | pending
  // Structured payer response: deductible remaining, annual max used,
  // frequency flags, payer note — whatever the clearinghouse port returned.
  coverage: jsonb("coverage").notNull().default({}),
  summary: text("summary").notNull().default(""), // human-readable (agent or template)
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  workflowId: text("workflow_id")
}, (t) => [
  index("elig_loc_pat_idx").on(t.locationId, t.patientSourceId),
  index("elig_loc_checked_idx").on(t.locationId, t.checkedAt)
]);

// Pre-authorizations (B3). One row per treatment-planned procedure that
// requires payer pre-auth; the preAuthorization workflow owns the lifecycle.
export const preauths = pgTable("preauths", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  procedureSourceId: bigint("procedure_source_id", { mode: "number" }).notNull(),
  planSourceId: bigint("plan_source_id", { mode: "number" }).notNull(),
  procCode: text("proc_code").notNull().default(""),
  fee: doublePrecision("fee").notNull().default(0),
  status: text("status").notNull().default("draft"), // draft | pending_approval | submitted | more_info | approved | denied
  narrative: text("narrative").notNull().default(""),
  missingItem: text("missing_item").notNull().default(""), // payer's named ask when more_info
  payerReference: text("payer_reference"),
  usedLlm: boolean("used_llm").notNull().default(false),
  workflowId: text("workflow_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (t) => [
  uniqueIndex("preauth_loc_proc_uq").on(t.locationId, t.procedureSourceId),
  index("preauth_loc_status_idx").on(t.locationId, t.status)
]);

// Claim denials (B4): classified remittance outcomes + appeal lifecycle.
// Category comes from the deterministic CARC map in @dental/shared; the
// billing agent may refine the summary within — never contradict — it.
export const claimDenials = pgTable("claim_denials", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  claimSourceId: bigint("claim_source_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  carcCodes: text("carc_codes").notNull().default(""), // comma-joined, like claims.carcCodes
  category: text("category").notNull(), // missing_documentation | frequency | not_covered | coordination_of_benefits | medical_necessity | administrative
  appealable: boolean("appealable").notNull().default(false),
  agentSummary: text("agent_summary").notNull().default(""),
  appealStatus: text("appeal_status").notNull().default("none"), // none | drafted | pending_approval | sent | won | lost
  appealLetter: text("appeal_letter").notNull().default(""),
  usedLlm: boolean("used_llm").notNull().default(false),
  workflowId: text("workflow_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (t) => [
  uniqueIndex("denials_loc_claim_uq").on(t.locationId, t.claimSourceId),
  index("denials_loc_status_idx").on(t.locationId, t.appealStatus)
]);

// Morning huddle digests (C1): one per (location, day). data holds the exact
// structured facts the narrative was drafted from (grounding discipline);
// actionItems is the ranked list the UI turns into tasks one click at a time.
export const huddleDigests = pgTable("huddle_digests", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  date: date("date").notNull(),
  narrative: text("narrative").notNull().default(""),
  data: jsonb("data").notNull().default({}),
  actionItems: jsonb("action_items").notNull().default([]),
  usedLlm: boolean("used_llm").notNull().default(false),
  workflowId: text("workflow_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [uniqueIndex("huddle_loc_date_uq").on(t.locationId, t.date)]);

// Clinical note embeddings for pgvector RAG (bge-small-en-v1.5 = 384 dims,
// generated locally by the agents service — no external embedding API).
export const noteEmbeddings = pgTable("note_embeddings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  locationId: bigint("location_id", { mode: "number" }).notNull(),
  commLogSourceId: bigint("comm_log_source_id", { mode: "number" }).notNull(),
  patientSourceId: bigint("patient_source_id", { mode: "number" }).notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 384 })
}, (t) => [
  uniqueIndex("noteemb_loc_src_uq").on(t.locationId, t.commLogSourceId),
  index("noteemb_vec_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))
]);
