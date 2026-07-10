import { z } from "zod";

// ---------------------------------------------------------------------------
// Sync events: Edge Synchronizer -> cloud ingest.
// The edge transforms raw OpenDental rows into these canonical payloads; the
// cloud never sees PMS-specific column names. Every payload keeps `sourceId`
// (the OpenDental *Num PK) so records upsert idempotently per (site, table, id).
// ---------------------------------------------------------------------------

export const SyncTable = z.enum([
  "provider",
  "operatory",
  "procedurecode",
  "patient",
  "appointment",
  "procedurelog",
  "insplan",
  "patplan",
  "claim",
  "claimproc",
  "recall",
  "commlog",
  "payment"
]);
export type SyncTable = z.infer<typeof SyncTable>;

export const ProviderPayload = z.object({
  abbr: z.string(),
  lastName: z.string(),
  firstName: z.string(),
  specialty: z.number(), // 0 dentist, 1 hygienist (sim convention)
  isHidden: z.boolean()
});

export const OperatoryPayload = z.object({
  name: z.string(),
  abbrev: z.string(),
  itemOrder: z.number(),
  defaultProviderId: z.number(),
  isHidden: z.boolean()
});

export const ProcedureCodePayload = z.object({
  procCode: z.string(),
  description: z.string(),
  abbrDesc: z.string()
});

export const PatientPayload = z.object({
  lastName: z.string(),
  firstName: z.string(),
  birthdate: z.string().nullable(), // YYYY-MM-DD
  gender: z.enum(["male", "female", "unknown"]),
  status: z.enum(["active", "inactive", "archived"]),
  homePhone: z.string(),
  wirelessPhone: z.string(),
  email: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  primaryProviderId: z.number(),
  firstVisit: z.string().nullable(),
  // Mirrors OpenDental TxtMsgOk (0 unknown / 1 yes / 2 no). Unknown counts as
  // consent for the sim; explicit opt-outs must never be texted (E1 enforces).
  smsConsent: z.boolean()
});

export const AppointmentStatus = z.enum(["scheduled", "complete", "unscheduled", "broken", "planned"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const AppointmentPayload = z.object({
  patientId: z.number(),
  status: AppointmentStatus,
  startsAt: z.string(), // ISO datetime, practice-local
  minutes: z.number(),
  confirmed: z.boolean(),
  operatoryId: z.number(),
  providerId: z.number(),
  note: z.string(),
  procDescript: z.string()
});

export const ProcedureLogPayload = z.object({
  patientId: z.number(),
  appointmentId: z.number(),
  procDate: z.string().nullable(),
  fee: z.number(),
  status: z.enum(["planned", "complete", "deleted", "other"]),
  providerId: z.number(),
  codeId: z.number(),
  toothNum: z.string(),
  surface: z.string()
});

export const InsPlanPayload = z.object({
  groupName: z.string(),
  groupNum: z.string(),
  carrierName: z.string(),
  planType: z.string(),
  // Insurance richness (A3): denormalized benefit facts the eligibility and
  // pre-auth workflows need. The sim seeds them; a real OD install would join
  // carrier + benefit tables at the edge.
  carrierPhone: z.string(),
  payerId: z.string(),
  annualMax: z.number(),
  deductible: z.number()
});

export const PatPlanPayload = z.object({
  patientId: z.number(),
  planId: z.number(),
  ordinal: z.number(),
  subscriberId: z.string()
});

export const ClaimPayload = z.object({
  patientId: z.number(),
  dateService: z.string().nullable(),
  dateSent: z.string().nullable(),
  status: z.enum(["unsent", "hold", "waiting", "sent", "received"]),
  claimFee: z.number(),
  insPayEst: z.number(),
  insPayAmt: z.number(),
  planId: z.number(),
  providerId: z.number(),
  note: z.string(),
  // Comma-joined CARC codes ("16,97") when the payer denied; "" otherwise.
  // Denial state is derived from this, not from ClaimStatus (OD has no
  // 'denied' status letter — a denied claim is Received with zero payment).
  carcCodes: z.string()
});

export const ClaimProcPayload = z.object({
  claimId: z.number(),
  procedureId: z.number(),
  patientId: z.number(),
  planId: z.number(),
  received: z.boolean(),
  feeBilled: z.number(),
  insPayEst: z.number(),
  insPayAmt: z.number(),
  writeOff: z.number()
});

export const RecallPayload = z.object({
  patientId: z.number(),
  dateDue: z.string().nullable(),
  datePrevious: z.string().nullable(),
  isDisabled: z.boolean()
});

export const CommlogPayload = z.object({
  patientId: z.number(),
  happenedAt: z.string(),
  commType: z.number(), // sim: 1 appointment, 2 billing, 3 clinical note, 4 text message
  note: z.string(),
  mode: z.number(),
  sentOrReceived: z.number()
});

// Payments (A4) — the 13th mirrored entity. Splits stay PMS-side; collections
// metrics only need the payment header.
export const PaymentPayload = z.object({
  patientId: z.number(),
  payDate: z.string().nullable(), // YYYY-MM-DD
  amount: z.number(),
  payType: z.number(), // sim: 1 check, 2 card, 3 cash, 4 insurance EFT
  note: z.string()
});

export const PAYLOAD_SCHEMAS: Record<SyncTable, z.ZodTypeAny> = {
  provider: ProviderPayload,
  operatory: OperatoryPayload,
  procedurecode: ProcedureCodePayload,
  patient: PatientPayload,
  appointment: AppointmentPayload,
  procedurelog: ProcedureLogPayload,
  insplan: InsPlanPayload,
  patplan: PatPlanPayload,
  claim: ClaimPayload,
  claimproc: ClaimProcPayload,
  recall: RecallPayload,
  commlog: CommlogPayload,
  payment: PaymentPayload
};

export const SyncEvent = z.object({
  // Deterministic id: `${siteKey}:${table}:${sourceId}:${stampEpochMs}` — the
  // ingest side dedupes on it, which is what makes redelivery after a crash safe.
  eventId: z.string(),
  table: SyncTable,
  sourceId: z.number(),
  stamp: z.string(), // DateTStamp of the row at capture time, ISO
  payload: z.unknown()
});
export type SyncEvent = z.infer<typeof SyncEvent>;

export const SyncBatch = z.object({
  siteKey: z.string(),
  sentAt: z.string(),
  events: z.array(SyncEvent).max(500)
});
export type SyncBatch = z.infer<typeof SyncBatch>;

export const SyncBatchAck = z.object({
  accepted: z.number(),
  duplicates: z.number()
});
export type SyncBatchAck = z.infer<typeof SyncBatchAck>;
