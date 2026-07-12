"use client";

// G1: location settings. The autoSendReminders policy flag (C2) gets its
// button, timezone gets a validated select (drives quiet-hours for patients
// without their own timezone), and the integration provenance badge stays
// read-only — the edge owns it via heartbeat.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Empty, PageTitle, Td, Th, fmtTime } from "@/components/ui";

interface LocationSettings {
  id: number;
  key: string;
  name: string;
  timezone: string;
  autoSendReminders: boolean;
  integrationMode: string;
  integrationStatus: string;
  lastHeartbeatAt: string | null;
}

const inputCls =
  "w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-teal";
const selectCls =
  "rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-teal";

function IntegrationCell({ l }: { l: LocationSettings }) {
  const beat = l.lastHeartbeatAt ? new Date(l.lastHeartbeatAt).getTime() : 0;
  const stale = beat > 0 && Date.now() - beat > 60_000;
  const label =
    l.integrationMode === "unknown" || beat === 0 ? "edge offline" :
    stale ? `${l.integrationMode} · stale` :
    l.integrationStatus === "degraded" ? `mock · degraded` :
    `live via ${l.integrationMode}`;
  const tone =
    l.integrationMode === "unknown" || beat === 0 || stale ? "bg-line/70 text-ink-soft" :
    l.integrationStatus === "degraded" || l.integrationMode === "mock" ? "bg-amber-soft text-amber" :
    "bg-mint text-pine";
  return (
    <div>
      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>
      {beat > 0 && (
        <div className="mt-1 text-[11px] text-ink-faint">heartbeat {fmtTime(l.lastHeartbeatAt!)}</div>
      )}
    </div>
  );
}

export default function AdminLocationsPage() {
  const { user: me } = useApp();
  const [rows, setRows] = useState<LocationSettings[] | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Browser-native IANA zones; the API validates against the same list.
  const timezones = useMemo<string[]>(
    () => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
    []
  );

  const load = useCallback(
    () =>
      api<LocationSettings[]>("/portal/admin/locations")
        .then((ls) => {
          setRows(ls);
          setNames(Object.fromEntries(ls.map((l) => [l.id, l.name])));
        })
        .catch((e) => setError((e as Error).message)),
    []
  );
  useEffect(() => { void load(); }, [load]);

  if (me.role !== "admin") {
    return (
      <>
        <PageTitle kicker="Administration" title="Locations" />
        <Card><Empty text="Location settings require the admin role." /></Card>
      </>
    );
  }

  async function patch(id: number, body: Record<string, unknown>, doneMsg?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ changed: string[] }>(`/portal/admin/locations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      if (doneMsg && res.changed.length > 0) setNotice(doneMsg);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load(); // roll back the optimistic control state
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle kicker="Administration" title="Locations" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Per-location policy and settings. Integration provenance is read-only — the edge
        synchronizer reports it via heartbeat.
      </p>

      {notice && (
        <div className="rise mb-4 rounded-md border border-teal/40 bg-mint/40 px-4 py-3 text-sm text-pine">
          {notice}
        </div>
      )}
      {error && (
        <div className="rise mb-4 rounded-md border border-coral/40 bg-coral-soft px-4 py-3 text-sm text-coral">
          {error}
        </div>
      )}

      <Card title={`Locations (${rows?.length ?? 0})`}>
        {!rows ? (
          <Empty text="Loading…" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <Th>Location</Th><Th>Name</Th><Th>Timezone</Th><Th>Auto-send reminders</Th><Th>Integration</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {rows.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      <span className="num rounded bg-line/60 px-2 py-0.5 text-[11px] font-semibold uppercase text-ink-soft">
                        site {l.key}
                      </span>
                    </Td>
                    <Td className="min-w-52">
                      <input
                        className={inputCls}
                        value={names[l.id] ?? l.name}
                        disabled={busy}
                        onChange={(e) => setNames({ ...names, [l.id]: e.target.value })}
                        onBlur={() => {
                          const name = (names[l.id] ?? "").trim();
                          if (name && name !== l.name) void patch(l.id, { name }, `Renamed to "${name}".`);
                        }}
                      />
                    </Td>
                    <Td>
                      <select
                        className={selectCls}
                        value={l.timezone}
                        disabled={busy}
                        onChange={(e) =>
                          void patch(l.id, { timezone: e.target.value },
                            `Timezone updated — quiet-hours sends now follow ${e.target.value}.`)}
                      >
                        {!timezones.includes(l.timezone) && <option value={l.timezone}>{l.timezone}</option>}
                        {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                      </select>
                    </Td>
                    <Td>
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-teal"
                          checked={l.autoSendReminders}
                          disabled={busy}
                          onChange={(e) =>
                            void patch(l.id, { autoSendReminders: e.target.checked },
                              e.target.checked
                                ? "Auto-send on — reminder sweeps send without an approval card."
                                : "Auto-send off — reminder batches park an approval card.")}
                        />
                        <span className="max-w-56 text-xs leading-snug text-ink-soft">
                          {l.autoSendReminders
                            ? "On — the nightly sweep sends reminders automatically."
                            : "Off — reminder batches park an approval card for review."}
                        </span>
                      </label>
                    </Td>
                    <Td><IntegrationCell l={l} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
