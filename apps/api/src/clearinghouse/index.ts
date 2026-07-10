import { Logger } from "@nestjs/common";
import { CLEARINGHOUSE, type ClearinghousePort } from "./clearinghouse.port";
import { MockClearinghouse } from "./mock.clearinghouse";

export * from "./clearinghouse.port";
export { MockClearinghouse } from "./mock.clearinghouse";

// Provider factory — same selection pattern as the SMS gateway: real
// clearinghouse creds configured → use them; else → deterministic mock. No
// real clearinghouse integration exists yet, so a configured URL only logs
// the intent and still binds the mock (the seam is what matters).
export const clearinghouseProvider = {
  provide: CLEARINGHOUSE,
  useFactory: (): ClearinghousePort => {
    const log = new Logger("Clearinghouse");
    if (process.env.CLEARINGHOUSE_URL) {
      log.warn(
        `CLEARINGHOUSE_URL is set but no real adapter is implemented yet — ` +
        `using the deterministic mock (same port, drop-in later).`
      );
    } else {
      log.log("using deterministic mock clearinghouse");
    }
    return new MockClearinghouse();
  }
};
