import type { PmsMode } from "@dental/shared";
import type { PmsAdapter } from "./adapter.js";
import { MySqlAdapter } from "./mysql.js";
import { MockAdapter } from "./mock.js";
import { OpenDentalApiAdapter } from "./opendental-api.js";

export * from "./adapter.js";
export { MySqlAdapter } from "./mysql.js";
export { MockAdapter } from "./mock.js";
export { OpenDentalApiAdapter, type OdApiConfig } from "./opendental-api.js";

export interface AdapterConfig {
  mysqlUrl?: string;
  odApiUrl?: string;
  odApiDeveloperKey?: string;
  odApiCustomerKey?: string;
  mockSeed: number;
  mockTickMs: number;
  onMockEvent?: (description: string) => void;
}

export function createAdapter(mode: PmsMode, cfg: AdapterConfig): PmsAdapter {
  switch (mode) {
    case "api":
      return new OpenDentalApiAdapter({
        baseUrl: cfg.odApiUrl ?? "",
        developerKey: cfg.odApiDeveloperKey ?? "",
        customerKey: cfg.odApiCustomerKey ?? ""
      });
    case "mysql": {
      if (!cfg.mysqlUrl) throw new Error("OPENDENTAL_<SITE>_URL is required for PMS_MODE=mysql");
      return new MySqlAdapter(cfg.mysqlUrl);
    }
    case "mock":
      return new MockAdapter({ seed: cfg.mockSeed, tickMs: cfg.mockTickMs, onEvent: cfg.onMockEvent });
  }
}
