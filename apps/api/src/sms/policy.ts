// E1: central outbound-message policy — consent, quiet hours, frequency caps.
// Pure and unit-tested (same split as slots.ts / noshow.ts): the services
// gather the facts (prefs row, sent counts), this module makes the call.
// Enforced in exactly one place per channel — SmsService.send() and
// EmailService.send() — so every workflow inherits it for free.
//
// Kinds:
//   outreach      platform-initiated (reminders, recall, backfill offers,
//                 treatment outreach, statements) — all three checks apply.
//   conversation  a reply within an exchange the patient is engaged in
//                 (slot menus, clarifying re-asks, decline acks) — consent
//                 only; making a patient who just texted us wait until 8am
//                 for the answer would kill every conversation workflow.
//   confirmation  transactional booking/appointment confirmations — consent
//                 only (the plan text exempts confirmations from caps; we
//                 treat them as urgent for quiet hours the same way).
//   notice        (email) transactional notices such as appeal-sent — same
//                 exemptions as confirmation.

export type MessageKind = "outreach" | "conversation" | "confirmation" | "notice";

export type BlockReason = "blocked_consent" | "blocked_quiet_hours" | "blocked_frequency";

export type PolicyDecision =
  | { action: "send" }
  | { action: "block"; reason: BlockReason; detail: string }
  | { action: "defer"; sendAt: Date; detail: string };

export interface PolicyInput {
  kind: MessageKind;
  /** Channel consent (sms_consent / email_consent) — prefs missing ⇒ consent assumed (PMS default). */
  consent: boolean;
  /** Sticky STOP timestamp — set ⇒ nothing goes out on SMS, ever, until staff intervene. */
  optedOut: boolean;
  now: Date;
  /** Patient-local timezone (patient_contact_prefs.timezone). */
  timezone: string;
  /** Outbound messages already sent/queued to this patient today (patient-local day) on this channel. */
  sentToday: number;
  /** Outbound messages in the trailing 7 days on this channel. */
  sentThisWeek: number;
}

export const QUIET_START_HOUR = 8; // messages allowed 08:00–19:59 patient-local
export const QUIET_END_HOUR = 20;
export const DAILY_CAP = 2;
export const WEEKLY_CAP = 6;

const CAPPED: Record<MessageKind, boolean> = {
  outreach: true, conversation: false, confirmation: false, notice: false
};

export function evaluateMessagePolicy(input: PolicyInput): PolicyDecision {
  if (input.optedOut || !input.consent) {
    return {
      action: "block",
      reason: "blocked_consent",
      detail: input.optedOut ? "patient opted out (STOP)" : "no consent on file"
    };
  }
  if (!CAPPED[input.kind]) return { action: "send" };

  if (input.sentToday >= DAILY_CAP || input.sentThisWeek >= WEEKLY_CAP) {
    return {
      action: "block",
      reason: "blocked_frequency",
      detail: input.sentToday >= DAILY_CAP
        ? `daily cap reached (${input.sentToday}/${DAILY_CAP})`
        : `weekly cap reached (${input.sentThisWeek}/${WEEKLY_CAP})`
    };
  }

  const hour = localHour(input.now, input.timezone);
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
    // Queue to the next 08:00 patient-local — deferred, never dropped.
    const sendAt = nextQuietWindowEnd(input.now, input.timezone);
    return { action: "defer", sendAt, detail: `quiet hours (${String(hour).padStart(2, "0")}:xx patient-local)` };
  }
  return { action: "send" };
}

// --- patient-local time helpers ---------------------------------------------------

export function localHour(now: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timezone), hour: "numeric", hour12: false
  }).format(now)) % 24; // Intl yields "24" for midnight in some ICU versions
}

/** UTC instant at which the patient's local calendar day started. */
export function localDayStartUtc(now: Date, timezone: string): Date {
  const zone = safeZone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "numeric", minute: "numeric", hour12: false
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return new Date(now.getTime() - (h * 60 + m) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
}

/**
 * The next moment the quiet window ends: today 08:00 patient-local if we're
 * before it, otherwise tomorrow 08:00. Hour-step search keeps this correct
 * across DST without date-math heroics.
 */
export function nextQuietWindowEnd(now: Date, timezone: string): Date {
  const zone = safeZone(timezone);
  // Walk forward hour by hour (max 25 to cross DST) until local hour is 8,
  // then snap back to the top of that local hour.
  let t = new Date(now.getTime());
  for (let i = 0; i < 26; i++) {
    t = new Date(t.getTime() + 3_600_000);
    if (localHour(t, zone) === QUIET_START_HOUR) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, minute: "numeric"
      }).formatToParts(t);
      const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
      return new Date(t.getTime() - m * 60_000 - t.getSeconds() * 1000 - t.getMilliseconds());
    }
  }
  return new Date(now.getTime() + 12 * 3_600_000); // unreachable fallback
}

function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "America/Chicago"; // the seeded default
  }
}

/** STOP / unsubscribe keywords (E1). Deliberately excludes CANCEL — in a dental
 * thread that usually means "cancel my appointment", not "stop texting me". */
export function isOptOutMessage(text: string): boolean {
  return /^\s*(stop|stopall|unsubscribe|opt[\s-]?out)\b/i.test(text);
}
