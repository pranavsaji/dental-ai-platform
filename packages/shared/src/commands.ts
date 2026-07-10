import { z } from "zod";

// ---------------------------------------------------------------------------
// Commands: cloud -> Edge Synchronizer write-back. This is the only path by
// which anything (including AI agents) mutates the on-prem PMS. The edge
// polls /edge/commands, applies each transactionally to OpenDental MySQL,
// then acks with the resulting OpenDental row id.
// ---------------------------------------------------------------------------

export const BookAppointmentCommand = z.object({
  type: z.literal("BookAppointment"),
  patientSourceId: z.number(), // OpenDental PatNum at the target site
  providerSourceId: z.number(),
  operatorySourceId: z.number(),
  startsAt: z.string(), // ISO datetime, practice-local
  minutes: z.number().min(10).max(240),
  procDescript: z.string(),
  note: z.string()
});

export const UpdateAppointmentStatusCommand = z.object({
  type: z.literal("UpdateAppointmentStatus"),
  appointmentSourceId: z.number(),
  status: z.enum(["scheduled", "complete", "broken", "unscheduled"])
});

// C2: flip OpenDental's confirmation status (the Confirmed column), which is
// separate from AptStatus — UpdateAppointmentStatus cannot express it.
export const ConfirmAppointmentCommand = z.object({
  type: z.literal("ConfirmAppointment"),
  appointmentSourceId: z.number()
});

export const AddCommlogCommand = z.object({
  type: z.literal("AddCommlog"),
  patientSourceId: z.number(),
  note: z.string(),
  commType: z.number(),
  mode: z.number(),
  sentOrReceived: z.number()
});

export const CommandPayload = z.discriminatedUnion("type", [
  BookAppointmentCommand,
  UpdateAppointmentStatusCommand,
  ConfirmAppointmentCommand,
  AddCommlogCommand
]);
export type CommandPayload = z.infer<typeof CommandPayload>;

export const EdgeCommand = z.object({
  commandId: z.string(),
  siteKey: z.string(),
  issuedAt: z.string(),
  payload: CommandPayload
});
export type EdgeCommand = z.infer<typeof EdgeCommand>;

export const CommandAck = z.object({
  commandId: z.string(),
  status: z.enum(["applied", "failed"]),
  // OpenDental row id created/affected by the command (e.g. new AptNum)
  resultSourceId: z.number().nullable(),
  error: z.string().nullable()
});
export type CommandAck = z.infer<typeof CommandAck>;
