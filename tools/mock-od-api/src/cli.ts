// Standalone runner: `pnpm --filter @dental/mock-od-api dev` serves an
// OD-API-shaped fixture on OD_API_PORT (default 8388). Point the edge at it:
//   PMS_MODE=api OD_API_URL=http://localhost:8388 pnpm --filter @dental/edge-sync dev:a

import { createMockOdApi } from "./server.js";

const port = Number(process.env.OD_API_PORT ?? 8388);
const seed = Number(process.env.MOCK_SEED ?? 101);
const api = createMockOdApi({ seed });
await api.listen(port);
console.log(`[mock-od-api] serving OD-shaped fixture (seed ${seed}) on http://localhost:${port}`);
