import { Module } from "@nestjs/common";
import { dbProvider } from "./db";
import { AuditService } from "./audit.service";
import { AuthController } from "./auth/auth";
import { OidcService } from "./auth/oidc.service";
import { SsoController } from "./auth/sso.controller";
import { SmsService } from "./sms/sms.service";
import { TwilioController } from "./sms/twilio.controller";
import { EdgeController } from "./edge/edge.controller";
import { EdgeAuthGuard } from "./edge/edge-auth.guard";
import { IngestService } from "./edge/ingest.service";
import { CommandsService } from "./edge/commands.service";
import { HooksService } from "./edge/hooks.service";
import { PortalController } from "./portal/portal.controller";
import { PortalService } from "./portal/portal.service";
import { ActionsController } from "./portal/actions.controller";
import { OpsController } from "./portal/ops.controller";
import { AgentsClient } from "./temporal/agents.client";
import { ActivitiesService } from "./temporal/activities.service";
import { TemporalService } from "./temporal/temporal.service";

@Module({
  controllers: [
    AuthController, SsoController, TwilioController,
    EdgeController, PortalController, ActionsController, OpsController
  ],
  providers: [
    dbProvider,
    AuditService,
    OidcService,
    SmsService,
    EdgeAuthGuard,
    IngestService,
    CommandsService,
    HooksService,
    PortalService,
    AgentsClient,
    ActivitiesService,
    TemporalService
  ]
})
export class AppModule {}
