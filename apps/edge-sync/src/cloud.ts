import type { CommandAck, EdgeCommand, EdgeHeartbeat, SyncBatch, SyncBatchAck } from "@dental/shared";
import { config } from "./config.js";

// Thin HTTP client for the cloud control plane. All calls authenticate with
// the per-site API key; the cloud resolves it to (org, location).

async function call<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.cloudUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-edge-api-key": config.apiKey,
      ...init?.headers
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${pathname} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export function pushBatch(batch: SyncBatch): Promise<SyncBatchAck> {
  return call<SyncBatchAck>("/edge/sync", { method: "POST", body: JSON.stringify(batch) });
}

export function fetchCommands(): Promise<EdgeCommand[]> {
  return call<EdgeCommand[]>("/edge/commands");
}

export function ackCommand(ack: CommandAck): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/edge/commands/ack", { method: "POST", body: JSON.stringify(ack) });
}

export function postHeartbeat(hb: EdgeHeartbeat): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>("/edge/heartbeat", { method: "POST", body: JSON.stringify(hb) });
}
