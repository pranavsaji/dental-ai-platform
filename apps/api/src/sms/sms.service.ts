// Pluggable SMS gateway. Every outbound patient text goes through send():
// with TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER set, the
// message is delivered via Twilio and the row carries the Message SID for
// status-callback reconciliation; without them, the row is recorded for the
// SMS Console simulator exactly as before. Either way the platform history,
// workflow routing, and audit trail are identical.
//
// E1: send() is ALSO the single policy-enforcement point — consent, quiet
// hours, and frequency caps are checked here (policy.ts), so every workflow
// inherits them for free. Rejections land on the message row as a typed
// blocked_* status; quiet-hours outreach is queued (send_after) and flushed
// by SmsOutboxService, never dropped.

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, inArray, notLike, sql } from "drizzle-orm";
import twilio from "twilio";
import { locations, patientContactPrefs, patients, smsMessages } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { normalizePhone } from "./phone";
import { evaluateMessagePolicy, localDayStartUtc, type MessageKind } from "./policy";

export function twilioConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? "",
    // Public base URL Twilio calls back on (e.g. an ngrok/Cloudflare tunnel).
    webhookBaseUrl: (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.API_URL ?? "").replace(/\/$/, "")
  };
}

export function twilioEnabled(): boolean {
  const c = twilioConfig();
  return Boolean(c.accountSid && c.authToken && c.fromNumber);
}

export interface SendResult {
  outcome: "sent" | "queued" | "blocked";
  reason?: string;
}

@Injectable()
export class SmsService {
  private readonly log = new Logger("Sms");
  private client: ReturnType<typeof twilio> | null = null;

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  private twilioClient() {
    if (!this.client) {
      const c = twilioConfig();
      this.client = twilio(c.accountSid, c.authToken);
    }
    return this.client;
  }

  async send(input: {
    orgId: number;
    locationId: number;
    patientSourceId: number;
    body: string;
    workflowId: string | null;
    actor: string;
    purpose: string;
    /** Policy class (E1). Defaults to outreach — the most-restricted kind. */
    kind?: MessageKind;
  }): Promise<SendResult> {
    const kind: MessageKind = input.kind ?? "outreach";
    const [patient] = await this.db
      .select({ wirelessPhone: patients.wirelessPhone })
      .from(patients)
      .where(and(
        eq(patients.locationId, input.locationId),
        eq(patients.sourceId, input.patientSourceId)
      ));
    const to = normalizePhone(patient?.wirelessPhone ?? "");

    const row = {
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: input.patientSourceId,
      direction: "outbound" as const,
      body: input.body,
      workflowId: input.workflowId,
      kind,
      toNumber: to ?? ""
    };

    // --- E1 policy gate -----------------------------------------------------
    const decision = await this.evaluatePolicy(input.locationId, input.patientSourceId, kind);
    if (decision.action === "block") {
      await this.db.insert(smsMessages).values({
        ...row, provider: "console", status: decision.reason, error: decision.detail
      });
      await this.audit.log({
        orgId: input.orgId, locationId: input.locationId, actorType: "agent",
        actor: input.actor, action: "sms.blocked", resource: "patient",
        resourceId: String(input.patientSourceId),
        purpose: `${decision.reason}: ${decision.detail} (${input.purpose})`
      });
      this.log.warn(`sms to patient ${input.patientSourceId} blocked: ${decision.reason} — ${decision.detail}`);
      return { outcome: "blocked", reason: decision.reason };
    }
    if (decision.action === "defer") {
      await this.db.insert(smsMessages).values({
        ...row, provider: "console", status: "queued_quiet_hours", sendAfter: decision.sendAt
      });
      await this.audit.log({
        orgId: input.orgId, locationId: input.locationId, actorType: "agent",
        actor: input.actor, action: "sms.queued", resource: "patient",
        resourceId: String(input.patientSourceId),
        purpose: `${decision.detail}; sends after ${decision.sendAt.toISOString()} (${input.purpose})`
      });
      return { outcome: "queued", reason: "quiet_hours" };
    }

    await this.deliver(row);
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: input.actor, action: "sms.sent", resource: "patient",
      resourceId: String(input.patientSourceId), purpose: input.purpose
    });
    return { outcome: "sent" };
  }

  /** Provider delivery + row insert (no policy — callers gate first). */
  private async deliver(row: {
    orgId: number; locationId: number; patientSourceId: number;
    direction: "outbound"; body: string; workflowId: string | null;
    kind: MessageKind; toNumber: string;
  }): Promise<void> {
    const to = row.toNumber || null;
    if (twilioEnabled() && to) {
      const c = twilioConfig();
      try {
        const msg = await this.twilioClient().messages.create({
          to,
          from: c.fromNumber,
          body: row.body,
          ...(c.webhookBaseUrl.startsWith("https")
            ? { statusCallback: `${c.webhookBaseUrl}/twilio/status` }
            : {})
        });
        await this.db.insert(smsMessages).values({
          ...row, provider: "twilio", providerSid: msg.sid, status: msg.status ?? "queued"
        });
      } catch (e) {
        // Record the failure and keep the workflow moving; delivery problems
        // surface in the SMS console rather than wedging Temporal retries.
        const message = (e as Error).message?.slice(0, 500) ?? "twilio send failed";
        this.log.warn(`twilio send to patient ${row.patientSourceId} failed: ${message}`);
        await this.db.insert(smsMessages).values({
          ...row, provider: "twilio", status: "failed", error: message
        });
      }
    } else {
      if (twilioEnabled() && !to) {
        this.log.warn(`patient ${row.patientSourceId} has no dialable number; recorded only`);
      }
      await this.db.insert(smsMessages).values({ ...row, provider: "console", status: "recorded" });
    }
  }

  /** Gather prefs + counts and run the pure policy (policy.ts). */
  private async evaluatePolicy(locationId: number, patientSourceId: number, kind: MessageKind) {
    const now = new Date();
    const [prefs] = await this.db
      .select({
        smsConsent: patientContactPrefs.smsConsent,
        optOutAt: patientContactPrefs.optOutAt,
        timezone: patientContactPrefs.timezone
      })
      .from(patientContactPrefs)
      .where(and(
        eq(patientContactPrefs.locationId, locationId),
        eq(patientContactPrefs.patientSourceId, patientSourceId)
      ));
    // G1: a patient without a prefs row lives on the practice's clock — quiet
    // hours follow the location timezone set in /admin/locations.
    const timezone = prefs?.timezone ?? (await this.locationTimezone(locationId));
    const { today, week } = await this.outboundCounts(locationId, patientSourceId, now, timezone);
    return evaluateMessagePolicy({
      kind,
      consent: prefs?.smsConsent ?? true, // no prefs row ⇒ PMS default (consented)
      optedOut: prefs?.optOutAt != null,
      now,
      timezone,
      sentToday: today,
      sentThisWeek: week
    });
  }

  private async locationTimezone(locationId: number): Promise<string> {
    const [loc] = await this.db.select({ timezone: locations.timezone })
      .from(locations).where(eq(locations.id, locationId));
    return loc?.timezone ?? "America/Chicago";
  }

  /** Outbound rows that count against the caps: everything except blocked_* (queued rows will send). */
  private async outboundCounts(locationId: number, patientSourceId: number, now: Date, timezone: string) {
    const dayStart = localDayStartUtc(now, timezone);
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const scope = and(
      eq(smsMessages.locationId, locationId),
      eq(smsMessages.patientSourceId, patientSourceId),
      eq(smsMessages.direction, "outbound"),
      notLike(smsMessages.status, "blocked%")
    );
    const [dayRow] = await this.db.select({ n: sql<number>`count(*)::int` }).from(smsMessages)
      .where(and(scope, gte(smsMessages.createdAt, dayStart)));
    const [weekRow] = await this.db.select({ n: sql<number>`count(*)::int` }).from(smsMessages)
      .where(and(scope, gte(smsMessages.createdAt, weekStart)));
    return { today: dayRow?.n ?? 0, week: weekRow?.n ?? 0 };
  }

  /**
   * E1 flusher hook: deliver queued_quiet_hours rows whose window has opened.
   * Consent is re-checked at flush time (a STOP may have landed while the
   * message waited); frequency is not — the row already claimed its slot.
   */
  async flushQueued(): Promise<number> {
    const due = await this.db.select().from(smsMessages)
      .where(and(
        eq(smsMessages.status, "queued_quiet_hours"),
        sql`${smsMessages.sendAfter} <= now()`
      ))
      .limit(50);
    let flushed = 0;
    for (const msg of due) {
      const [prefs] = await this.db
        .select({ smsConsent: patientContactPrefs.smsConsent, optOutAt: patientContactPrefs.optOutAt })
        .from(patientContactPrefs)
        .where(and(
          eq(patientContactPrefs.locationId, msg.locationId),
          eq(patientContactPrefs.patientSourceId, msg.patientSourceId)
        ));
      if (prefs && (prefs.optOutAt != null || prefs.smsConsent === false)) {
        await this.db.update(smsMessages)
          .set({ status: "blocked_consent", error: "opted out while queued" })
          .where(eq(smsMessages.id, msg.id));
        continue;
      }
      // Mark before delivering so a crash can't double-send; deliver() writes
      // a fresh row with the real provider status.
      await this.db.delete(smsMessages).where(eq(smsMessages.id, msg.id));
      await this.deliver({
        orgId: msg.orgId,
        locationId: msg.locationId,
        patientSourceId: msg.patientSourceId,
        direction: "outbound",
        body: msg.body,
        workflowId: msg.workflowId,
        kind: (msg.kind as MessageKind) ?? "outreach",
        toNumber: msg.toNumber
      });
      await this.audit.log({
        orgId: msg.orgId, locationId: msg.locationId, actorType: "system",
        actor: "sms-outbox", action: "sms.sent", resource: "patient",
        resourceId: String(msg.patientSourceId), purpose: "quiet-hours queue flush"
      });
      flushed++;
    }
    return flushed;
  }

  /** E1: sticky opt-out — also kills anything still waiting in the queue. */
  async optOut(orgId: number, locationId: number, patientSourceId: number): Promise<void> {
    await this.db.insert(patientContactPrefs).values({
      orgId, locationId, patientSourceId,
      smsConsent: false,
      optOutAt: new Date(),
      consentSource: "sms_stop",
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: [patientContactPrefs.locationId, patientContactPrefs.patientSourceId],
      set: {
        smsConsent: false,
        optOutAt: sql`coalesce(${patientContactPrefs.optOutAt}, now())`,
        consentSource: "sms_stop",
        updatedAt: new Date()
      }
    });
    await this.db.update(smsMessages)
      .set({ status: "blocked_consent", error: "patient opted out (STOP)" })
      .where(and(
        eq(smsMessages.locationId, locationId),
        eq(smsMessages.patientSourceId, patientSourceId),
        inArray(smsMessages.status, ["queued_quiet_hours"])
      ));
    await this.audit.log({
      orgId, locationId, actorType: "system", actor: "inbound-router",
      action: "sms.opted_out", resource: "patient",
      resourceId: String(patientSourceId), purpose: "STOP reply — sticky opt-out"
    });
    this.log.log(`patient ${patientSourceId} opted out (STOP)`);
  }
}
