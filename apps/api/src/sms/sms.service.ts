// Pluggable SMS gateway. Every outbound patient text goes through send():
// with TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER set, the
// message is delivered via Twilio and the row carries the Message SID for
// status-callback reconciliation; without them, the row is recorded for the
// SMS Console simulator exactly as before. Either way the platform history,
// workflow routing, and audit trail are identical.

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import twilio from "twilio";
import { patients, smsMessages } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { normalizePhone } from "./phone";

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
  }): Promise<void> {
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
      toNumber: to ?? ""
    };

    if (twilioEnabled() && to) {
      const c = twilioConfig();
      try {
        const msg = await this.twilioClient().messages.create({
          to,
          from: c.fromNumber,
          body: input.body,
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
        this.log.warn(`twilio send to patient ${input.patientSourceId} failed: ${message}`);
        await this.db.insert(smsMessages).values({
          ...row, provider: "twilio", status: "failed", error: message
        });
      }
    } else {
      if (twilioEnabled() && !to) {
        this.log.warn(`patient ${input.patientSourceId} has no dialable number; recorded only`);
      }
      await this.db.insert(smsMessages).values({ ...row, provider: "console", status: "recorded" });
    }

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: input.actor, action: "sms.sent", resource: "patient",
      resourceId: String(input.patientSourceId), purpose: input.purpose
    });
  }
}
