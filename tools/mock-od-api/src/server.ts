// Mock OpenDental REST API (A1): a tiny fixture server that serves
// OD-API-shaped JSON from the practice simulator's in-memory model. Used to
// integration-test OpenDentalApiAdapter (no real OD install exists in dev)
// and to demo PMS_MODE=api end to end.
//
// Endpoints mirror the ODApi surface the adapter touches:
//   GET  /<resource>?DateTStamp=<stamp>&limit=<n>   incremental reads
//   POST /appointments                              create (returns AptNum)
//   PUT  /appointments/:id                          patch (e.g. AptStatus)
//   POST /commlogs                                  create (returns CommlogNum)
// Auth: expects an "ODFHIR dev/cust" Authorization header (any non-empty keys).

import http from "node:http";
import { InMemoryPractice, OD_PK, buildPractice } from "@dental/simulator";

const RESOURCES: Record<string, string> = {
  providers: "provider",
  operatories: "operatory",
  procedurecodes: "procedurecode",
  patients: "patient",
  appointments: "appointment",
  procedurelogs: "procedurelog",
  insplans: "insplan",
  patplans: "patplan",
  claims: "claim",
  claimprocs: "claimproc",
  recalls: "recall",
  commlogs: "commlog",
  payments: "payment"
};

export interface MockOdApiOptions {
  seed?: number;
  practice?: InMemoryPractice;
}

export interface MockOdApi {
  server: http.Server;
  practice: InMemoryPractice;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createMockOdApi(opts: MockOdApiOptions = {}): MockOdApi {
  const practice = opts.practice ?? buildPractice(opts.seed ?? 1);

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("ODFHIR ")) return send(401, { error: "missing ODFHIR authorization" });

    const url = new URL(req.url ?? "/", "http://localhost");
    const [resource, idPart] = url.pathname.split("/").filter(Boolean);
    const table = RESOURCES[resource ?? ""];
    if (!table) return send(404, { error: `unknown resource '${resource}'` });

    if (req.method === "GET") {
      const stamp = url.searchParams.get("DateTStamp") ?? "1970-01-01 00:00:00";
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      // OD-API-style paging: stamp filter + limit/offset (no keyset pk param —
      // the adapter's client-side cursor filter handles same-stamp bulk rows).
      return send(200, practice.rowsSince(table, { stamp, pk: 0 }, offset + limit).slice(offset));
    }

    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body: Record<string, any>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "invalid JSON" });
      }
      if (req.method === "POST") {
        const id = practice.insert(table, body);
        return send(201, practice.get(table, id));
      }
      if (req.method === "PUT") {
        const id = Number(idPart);
        if (!practice.get(table, id)) return send(404, { error: `${OD_PK[table]} ${id} not found` });
        practice.update(table, id, body);
        return send(200, practice.get(table, id));
      }
      return send(405, { error: "method not allowed" });
    });
  });

  return {
    server,
    practice,
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
