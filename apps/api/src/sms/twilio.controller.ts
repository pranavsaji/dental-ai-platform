// Twilio webhooks. Both endpoints require a valid X-Twilio-Signature computed
// with TWILIO_AUTH_TOKEN over the exact public URL Twilio called
// (TWILIO_WEBHOOK_BASE_URL + path) — unsigned or forged posts are rejected,
// and the endpoints are disabled entirely when Twilio isn't configured.
// The in-app SMS Console simulator (/portal/sms/inbound) remains available
// either way.

import { Controller, Inject, Logger, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import twilio from "twilio";
import { and, desc, eq, sql } from "drizzle-orm";
import { locations, patients, smsMessages } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { twilioConfig, twilioEnabled } from "./sms.service";
import { InboundRouterService } from "./inbound-router.service";

@Controller("twilio")
export class TwilioController {
  private readonly log = new Logger("TwilioWebhook");

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService,
    private inboundRouter: InboundRouterService
  ) {}

  private verify(req: Request, res: Response, path: string): boolean {
    if (!twilioEnabled()) {
      res.status(503).send("Twilio not configured");
      return false;
    }
    const c = twilioConfig();
    const signature = req.headers["x-twilio-signature"];
    const valid = typeof signature === "string" && twilio.validateRequest(
      c.authToken, signature, `${c.webhookBaseUrl}${path}`, (req.body ?? {}) as Record<string, string>
    );
    if (!valid) {
      this.log.warn(`rejected unsigned/forged webhook on ${path}`);
      res.status(403).send("Invalid signature");
      return false;
    }
    return true;
  }

  // Inbound patient SMS. Routing mirrors the simulator: match the sender's
  // number to a patient, thread the reply onto the workflow that most
  // recently texted them, and signal it.
  @Post("sms")
  async inbound(@Req() req: Request, @Res() res: Response) {
    if (!this.verify(req, res, "/twilio/sms")) return;
    const body = (req.body ?? {}) as { From?: string; To?: string; Body?: string; MessageSid?: string };
    const text = (body.Body ?? "").trim();
    const fromDigits = (body.From ?? "").replace(/\D/g, "");
    const last10 = fromDigits.slice(-10);
    res.type("text/xml");

    if (!text || last10.length < 10) return res.send("<Response></Response>");

    const matches = await this.db
      .select({
        orgId: patients.orgId,
        locationId: patients.locationId,
        sourceId: patients.sourceId
      })
      .from(patients)
      .where(sql`right(regexp_replace(${patients.wirelessPhone}, '\\D', '', 'g'), 10) = ${last10}`)
      .limit(5);
    if (matches.length === 0) {
      this.log.warn(`inbound SMS from unknown number ending ${last10.slice(-4)}`);
      return res.send("<Response></Response>");
    }

    // If the number maps to multiple patients (family plan), prefer the one
    // we texted most recently.
    let chosen = matches[0];
    let lastOutbound: typeof smsMessages.$inferSelect | undefined;
    for (const m of matches) {
      const [row] = await this.db.select().from(smsMessages)
        .where(and(
          eq(smsMessages.locationId, m.locationId),
          eq(smsMessages.patientSourceId, m.sourceId),
          eq(smsMessages.direction, "outbound")
        ))
        .orderBy(desc(smsMessages.createdAt))
        .limit(1);
      if (row && (!lastOutbound || row.createdAt > lastOutbound.createdAt)) {
        lastOutbound = row;
        chosen = m;
      }
    }

    await this.db.insert(smsMessages).values({
      orgId: chosen.orgId,
      locationId: chosen.locationId,
      patientSourceId: chosen.sourceId,
      direction: "inbound",
      body: text,
      workflowId: lastOutbound?.workflowId ?? null,
      provider: "twilio",
      providerSid: body.MessageSid ?? null,
      toNumber: body.To ?? "",
      status: "received"
    });
    await this.audit.log({
      orgId: chosen.orgId, locationId: chosen.locationId, actorType: "system",
      actor: "twilio", action: "sms.received", resource: "patient",
      resourceId: String(chosen.sourceId), purpose: "inbound patient reply"
    });

    // Keyword fast-path (CHANGE → reschedule) + reply threading (C3).
    const [loc] = await this.db
      .select({ key: locations.key })
      .from(locations)
      .where(eq(locations.id, chosen.locationId));
    await this.inboundRouter.route({
      orgId: chosen.orgId,
      locationId: chosen.locationId,
      siteKey: loc?.key ?? "",
      patientSourceId: chosen.sourceId,
      body: text,
      lastWorkflowId: lastOutbound?.workflowId ?? null
    });
    return res.send("<Response></Response>");
  }

  // Delivery-status callback: reconcile queued -> sent -> delivered/failed.
  @Post("status")
  async status(@Req() req: Request, @Res() res: Response) {
    if (!this.verify(req, res, "/twilio/status")) return;
    const body = (req.body ?? {}) as { MessageSid?: string; MessageStatus?: string; ErrorCode?: string };
    if (body.MessageSid && body.MessageStatus) {
      await this.db.update(smsMessages)
        .set({
          status: body.MessageStatus,
          ...(body.ErrorCode ? { error: `twilio error ${body.ErrorCode}` } : {})
        })
        .where(eq(smsMessages.providerSid, body.MessageSid));
    }
    return res.status(204).send();
  }
}
