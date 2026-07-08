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
  abbrDesc: text("abbr_desc").notNull()
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
  procDescript: text("proc_descript").notNull().default("")
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
  planType: text("plan_type").notNull()
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
  note: text("note").notNull().default("")
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
