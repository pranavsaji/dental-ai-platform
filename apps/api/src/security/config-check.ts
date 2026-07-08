// Startup configuration gate (SOC 2 CC6.1 / CC8.1). In production the API
// refuses to boot with known dev-default secrets; in development it prints
// loud warnings so the gap is never invisible. See compliance/ for the
// control mapping.

import { Logger } from "@nestjs/common";

const DEV_DEFAULTS: Array<{ env: string; value: string }> = [
  { env: "JWT_SECRET", value: "dev-jwt-secret-change-me" },
  { env: "EDGE_SITE_A_API_KEY", value: "edge-key-site-a-dev" },
  { env: "EDGE_SITE_B_API_KEY", value: "edge-key-site-b-dev" }
];

export function assertSecureConfig(): void {
  const log = new Logger("ConfigCheck");
  const production = process.env.NODE_ENV === "production";
  const problems: string[] = [];

  for (const d of DEV_DEFAULTS) {
    const current = process.env[d.env];
    if (!current || current === d.value) {
      problems.push(`${d.env} is unset or still the dev default`);
    }
  }
  if ((process.env.JWT_SECRET ?? "").length > 0 && (process.env.JWT_SECRET ?? "").length < 32 && production) {
    problems.push("JWT_SECRET is shorter than 32 characters");
  }

  if (problems.length === 0) return;
  if (production) {
    for (const p of problems) log.error(p);
    throw new Error("Refusing to start in production with insecure configuration (see errors above)");
  }
  for (const p of problems) log.warn(`${p} — acceptable for local dev only`);
}
