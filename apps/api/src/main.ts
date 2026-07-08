import "reflect-metadata";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { assertSecureConfig } from "./security/config-check";

async function bootstrap() {
  assertSecureConfig();
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  app.use(helmet());
  const webUrl = process.env.WEB_URL ?? "http://localhost:3000";
  app.enableCors({ origin: [webUrl], credentials: true });
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`[api] control plane listening on :${port}`);
}
void bootstrap();
