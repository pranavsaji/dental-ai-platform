import { Module } from "@nestjs/common";
import { dbProvider } from "./db";
import { AuditService } from "./audit.service";
import { AuthController } from "./auth/auth";
import { OidcService } from "./auth/oidc.service";
import { SsoController } from "./auth/sso.controller";
import { SmsService } from "./sms/sms.service";
import { InboundRouterService } from "./sms/inbound-router.service";
import { TwilioController } from "./sms/twilio.controller";
import { EdgeController } from "./edge/edge.controller";
import { EdgeAuthGuard } from "./edge/edge-auth.guard";
import { IngestService } from "./edge/ingest.service";
import { CommandsService } from "./edge/commands.service";
import { HeartbeatService } from "./edge/heartbeat.service";
import { HooksService } from "./edge/hooks.service";
import { PortalController } from "./portal/portal.controller";
import { PortalService } from "./portal/portal.service";
import { ActionsController } from "./portal/actions.controller";
import { OpsController } from "./portal/ops.controller";
import { TasksController } from "./portal/tasks.controller";
import { TasksService } from "./portal/tasks.service";
import { BillingController } from "./portal/billing.controller";
import { BillingService } from "./portal/billing.service";
import { AnalyticsController } from "./portal/analytics.controller";
import { AnalyticsService } from "./portal/analytics.service";
import { MetricsService } from "./portal/metrics.service";
import { clearinghouseProvider } from "./clearinghouse";
import { AgentsClient } from "./temporal/agents.client";
import { ActivitiesService } from "./temporal/activities.service";
import { TemporalService } from "./temporal/temporal.service";

@Module({
  controllers: [
    AuthController, SsoController, TwilioController,
    EdgeController, PortalController, ActionsController, OpsController,
    TasksController, BillingController, AnalyticsController
  ],
  providers: [
    dbProvider,
    AuditService,
    OidcService,
    SmsService,
    InboundRouterService,
    EdgeAuthGuard,
    IngestService,
    CommandsService,
    HeartbeatService,
    HooksService,
    PortalService,
    TasksService,
    BillingService,
    AnalyticsService,
    MetricsService,
    clearinghouseProvider,
    AgentsClient,
    ActivitiesService,
    TemporalService
  ]
})
export class AppModule {}
