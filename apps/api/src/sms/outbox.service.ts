// E1: quiet-hours messages are deferred, never dropped. This flusher walks
// both channels' queued_quiet_hours rows every 30 seconds and delivers the
// ones whose patient-local morning has arrived. Consent is re-checked at
// flush time by each channel service (a STOP can land while a message waits).
// In-process interval, same trade-off as the in-process Temporal worker —
// a single API instance owns the queue in this stack.

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { SmsService } from "./sms.service";
import { EmailService } from "../email/email.service";

const FLUSH_INTERVAL_MS = 30_000;

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Outbox");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private sms: SmsService,
    private email: EmailService
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async flush(): Promise<void> {
    if (this.running) return; // no overlapping runs
    this.running = true;
    try {
      const sms = await this.sms.flushQueued();
      const emails = await this.email.flushQueued();
      if (sms + emails > 0) this.log.log(`flushed ${sms} SMS + ${emails} email(s) from the quiet-hours queue`);
    } catch (err) {
      this.log.error(`flush failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
