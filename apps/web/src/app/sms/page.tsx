"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Empty, PageTitle } from "@/components/ui";

interface Sms {
  id: number; patientSourceId: number; direction: "outbound" | "inbound";
  body: string; createdAt: string; patientFirst?: string | null; patientLast?: string | null;
  provider?: string; status?: string; error?: string | null;
}

// Simulated SMS gateway console: outbound messages sent by agents appear here,
// and you reply *as the patient* to drive the workflow forward.
export default function SmsPage() {
  const { location } = useApp();
  const [rows, setRows] = useState<Sms[]>([]);
  const [reply, setReply] = useState("YES");
  const [target, setTarget] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!location) return;
    api<Sms[]>(`/portal/sms?locationId=${location.id}`).then((r) => {
      setRows(r);
      if (r.length > 0 && target === null) setTarget(r[r.length - 1].patientSourceId);
    }).catch(() => {});
  }, [location, target]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function send() {
    if (!location || !target) return;
    await api("/portal/sms/inbound", {
      method: "POST",
      body: JSON.stringify({ locationId: location.id, patientSourceId: target, body: reply })
    });
    setReply("");
    load();
  }

  const patients = [...new Map(rows.map((r) => [r.patientSourceId, r])).values()];

  return (
    <div>
      <PageTitle kicker="Simulator" title="SMS Console" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        A stand-in for Twilio. Agent outreach lands here; type a reply to act as the patient.
      </p>
      <Card>
        {rows.length === 0 ? (
          <Empty text="No messages yet. Approve an outreach proposal first." />
        ) : (
          <div className="flex max-h-[30rem] flex-col gap-3 overflow-y-auto px-5 py-4">
            {rows.map((m) => (
              <div key={m.id} className={`max-w-[34rem] ${m.direction === "outbound" ? "self-start" : "self-end"}`}>
                <div className={`rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed shadow-sm ${
                  m.direction === "outbound" ? "rounded-bl-sm bg-pine text-mint" : "rounded-br-sm bg-mint text-pine"
                }`}>
                  {m.body}
                </div>
                <div className={`mt-1 text-[10.5px] text-ink-faint ${m.direction === "inbound" ? "text-right" : ""}`}>
                  {m.direction === "outbound" ? "Clinic → " : "← "}
                  patient #{m.patientSourceId}
                  {m.patientLast ? ` (${m.patientLast}, ${m.patientFirst})` : ""} ·{" "}
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  {m.provider === "twilio" && (
                    <span className={m.status === "failed" ? "text-coral" : "text-teal"}>
                      {" "}· twilio {m.status}{m.error ? ` — ${m.error}` : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line/70 px-5 py-3">
          <select
            className="rounded-md border border-line bg-surface px-2 py-2 text-sm outline-none"
            value={target ?? ""}
            onChange={(e) => setTarget(Number(e.target.value))}
          >
            <option value="" disabled>Reply as…</option>
            {patients.map((p) => (
              <option key={p.patientSourceId} value={p.patientSourceId}>
                #{p.patientSourceId} {p.patientLast ? `${p.patientLast}, ${p.patientFirst}` : ""}
              </option>
            ))}
          </select>
          <input
            className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder='Reply as the patient (try "YES")'
          />
          <button onClick={send} className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white hover:bg-pine-2">
            Send
          </button>
        </div>
      </Card>
    </div>
  );
}
