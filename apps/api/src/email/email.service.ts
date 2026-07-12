// E3: email as a second channel, cloned from the SmsService seam — with
// SMTP_URL (+ EMAIL_FROM) configured, mail goes out via SMTP (nodemailer);
// without it, the row is recorded for the Email tab of the comms console.
// Same E1 policy gate as SMS: consent (email_consent), quiet hours, and
// frequency caps are enforced HERE, in the one place every caller flows
// through. Outreach kinds defer through the same queued/flush mechanics.

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, notLike, sql } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { emailMessages, locations, patientContactPrefs, patients } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { evaluateMessagePolicy, localDayStartUtc, type MessageKind } from "../sms/policy";
import type { RenderedEmail } from "./templates";

export function smtpConfig() {
  return {
    url: process.env.SMTP_URL ?? "",
    from: process.env.EMAIL_FROM ?? "no-reply@lonestar-dental.example"
  };
}

export function smtpEnabled(): boolean {
  return Boolean(smtpConfig().url);
}

export interface EmailSendResult {
  outcome: "sent" | "queued" | "blocked";
  reason?: string;
}

@Injectable()
export class EmailService {
  private readonly log = new Logger("Email");
  private transporter: Transporter | null = null;

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  private smtp(): Transporter {
    if (!this.transporter) this.transporter = nodemailer.createTransport(smtpConfig().url);
    return this.transporter;
  }

  /** Patient-facing send — policy-gated (consent, quiet hours, caps). */
  async sendToPatient(input: {
    orgId: number;
    locationId: number;
    patientSourceId: number;
    email: RenderedEmail;
    workflowId: string | null;
    actor: string;
    purpose: string;
    /** outreach (default) is fully policy-checked; notice is consent-only. */
    kind?: Extract<MessageKind, "outreach" | "notice">;
  }): Promise<EmailSendResult> {
    const kind = input.kind ?? "outreach";
    const [patient] = await this.db
      .select({ email: patients.email })
      .from(patients)
      .where(and(
        eq(patients.locationId, input.locationId),
        eq(patients.sourceId, input.patientSourceId)
      ));
    const to = (patient?.email ?? "").trim();

    const row = {
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: input.patientSourceId,
      toEmail: to,
      subject: input.email.subject,
      bodyHtml: input.email.bodyHtml,
      template: input.email.template,
      templateVersion: input.email.templateVersion,
      workflowId: input.workflowId,
      kind
    };

    if (!to) {
      await this.db.insert(emailMessages).values({
        ...row, provider: "console", status: "blocked_consent", error: "no email address on file"
      });
      return { outcome: "blocked", reason: "no_email" };
    }

    const decision = await this.evaluatePolicy(input.locationId, input.patientSourceId, kind);
    if (decision.action === "block") {
      await this.db.insert(emailMessages).values({
        ...row, provider: "console", status: decision.reason, error: decision.detail
      });
      await this.audit.log({
        orgId: input.orgId, locationId: input.locationId, actorType: "agent",
        actor: input.actor, action: "email.blocked", resource: "patient",
        resourceId: String(input.patientSourceId),
        purpose: `${decision.reason}: ${decision.detail} (${input.purpose})`
      });
      return { outcome: "blocked", reason: decision.reason };
    }
    if (decision.action === "defer") {
      await this.db.insert(emailMessages).values({
        ...row, provider: "console", status: "queued_quiet_hours", sendAfter: decision.sendAt
      });
      await this.audit.log({
        orgId: input.orgId, locationId: input.locationId, actorType: "agent",
        actor: input.actor, action: "email.queued", resource: "patient",
        resourceId: String(input.patientSourceId),
        purpose: `${decision.detail}; sends after ${decision.sendAt.toISOString()} (${input.purpose})`
      });
      return { outcome: "queued", reason: "quiet_hours" };
    }

    await this.deliver(row);
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: input.actor, action: "email.sent", resource: "patient",
      resourceId: String(input.patientSourceId), purpose: input.purpose
    });
    return { outcome: "sent" };
  }

  /** Staff-facing send (e.g. the huddle digest to a user) — no patient policy. */
  async sendToStaff(input: {
    orgId: number;
    locationId: number;
    toEmail: string;
    email: RenderedEmail;
    actor: string;
    purpose: string;
  }): Promise<EmailSendResult> {
    await this.deliver({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: null,
      toEmail: input.toEmail,
      subject: input.email.subject,
      bodyHtml: input.email.bodyHtml,
      template: input.email.template,
      templateVersion: input.email.templateVersion,
      workflowId: null,
      kind: "notice"
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "user",
      actor: input.actor, action: "email.sent", resource: "user",
      resourceId: input.toEmail, purpose: input.purpose
    });
    return { outcome: "sent" };
  }

  private async deliver(row: {
    orgId: number; locationId: number; patientSourceId: number | null;
    toEmail: string; subject: string; bodyHtml: string; template: string;
    templateVersion: number; workflowId: string | null; kind: string;
  }): Promise<void> {
    if (smtpEnabled() && row.toEmail) {
      try {
        await this.smtp().sendMail({
          from: smtpConfig().from,
          to: row.toEmail,
          subject: row.subject,
          html: row.bodyHtml
        });
        await this.db.insert(emailMessages).values({ ...row, provider: "smtp", status: "sent" });
      } catch (e) {
        const message = (e as Error).message?.slice(0, 500) ?? "smtp send failed";
        this.log.warn(`smtp send to ${row.toEmail} failed: ${message}`);
        await this.db.insert(emailMessages).values({ ...row, provider: "smtp", status: "failed", error: message });
      }
    } else {
      await this.db.insert(emailMessages).values({ ...row, provider: "console", status: "recorded" });
    }
  }

  private async evaluatePolicy(locationId: number, patientSourceId: number, kind: MessageKind) {
    const now = new Date();
    const [prefs] = await this.db
      .select({
        emailConsent: patientContactPrefs.emailConsent,
        timezone: patientContactPrefs.timezone
      })
      .from(patientContactPrefs)
      .where(and(
        eq(patientContactPrefs.locationId, locationId),
        eq(patientContactPrefs.patientSourceId, patientSourceId)
      ));
    // G1: no prefs row ⇒ the location's timezone (set in /admin/locations).
    const timezone = prefs?.timezone ?? (await this.locationTimezone(locationId));
    const { today, week } = await this.outboundCounts(locationId, patientSourceId, now, timezone);
    return evaluateMessagePolicy({
      kind,
      consent: prefs?.emailConsent ?? true,
      optedOut: false, // opt_out_at is the SMS STOP flag; email consent is its own bit
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

  private async outboundCounts(locationId: number, patientSourceId: number, now: Date, timezone: string) {
    const dayStart = localDayStartUtc(now, timezone);
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const scope = and(
      eq(emailMessages.locationId, locationId),
      eq(emailMessages.patientSourceId, patientSourceId),
      notLike(emailMessages.status, "blocked%")
    );
    const [dayRow] = await this.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages)
      .where(and(scope, gte(emailMessages.createdAt, dayStart)));
    const [weekRow] = await this.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages)
      .where(and(scope, gte(emailMessages.createdAt, weekStart)));
    return { today: dayRow?.n ?? 0, week: weekRow?.n ?? 0 };
  }

  /** Flush queued_quiet_hours emails whose window opened (same contract as SMS). */
  async flushQueued(): Promise<number> {
    const due = await this.db.select().from(emailMessages)
      .where(and(
        eq(emailMessages.status, "queued_quiet_hours"),
        sql`${emailMessages.sendAfter} <= now()`
      ))
      .limit(50);
    let flushed = 0;
    for (const msg of due) {
      if (msg.patientSourceId != null) {
        const [prefs] = await this.db
          .select({ emailConsent: patientContactPrefs.emailConsent })
          .from(patientContactPrefs)
          .where(and(
            eq(patientContactPrefs.locationId, msg.locationId),
            eq(patientContactPrefs.patientSourceId, msg.patientSourceId)
          ));
        if (prefs && prefs.emailConsent === false) {
          await this.db.update(emailMessages)
            .set({ status: "blocked_consent", error: "consent revoked while queued" })
            .where(eq(emailMessages.id, msg.id));
          continue;
        }
      }
      await this.db.delete(emailMessages).where(eq(emailMessages.id, msg.id));
      await this.deliver({
        orgId: msg.orgId,
        locationId: msg.locationId,
        patientSourceId: msg.patientSourceId,
        toEmail: msg.toEmail,
        subject: msg.subject,
        bodyHtml: msg.bodyHtml,
        template: msg.template,
        templateVersion: msg.templateVersion,
        workflowId: msg.workflowId,
        kind: msg.kind
      });
      flushed++;
    }
    return flushed;
  }
}
