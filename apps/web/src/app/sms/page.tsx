"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Empty, PageTitle } from "@/components/ui";
import { RequireRole } from "@/components/require-role";

interface Sms {
  id: number; patientSourceId: number; direction: "outbound" | "inbound";
  body: string; createdAt: string; patientFirst?: string | null; patientLast?: string | null;
  provider?: string; status?: string; error?: string | null; kind?: string;
}

interface Email {
  id: number; patientSourceId: number | null; toEmail: string; subject: string;
  bodyHtml: string; template: string; templateVersion: number; provider: string;
  kind: string; status: string; error?: string | null; createdAt: string;
  patientFirst?: string | null; patientLast?: string | null;
}

// E1: policy outcomes surface right in the console — the human sees exactly
// why a message never left the platform, or when a queued one will.
const POLICY_LABELS: Record<string, string> = {
  blocked_consent: "blocked — no consent / opted out",
  blocked_quiet_hours: "blocked — quiet hours",
  blocked_frequency: "blocked — frequency cap",
  queued_quiet_hours: "queued — sends at 8:00 patient time"
};

// Simulated comms gateway console: outbound SMS + email sent by agents appear
// here; on the SMS tab you reply *as the patient* to drive workflows forward.
function SmsPage() {
  const { location } = useApp();
  const [tab, setTab] = useState<"sms" | "email">("sms");
  const [rows, setRows] = useState<Sms[]>([]);
  const [emails, setEmails] = useState<Email[]>([]);
  const [openEmail, setOpenEmail] = useState<number | null>(null);
  const [reply, setReply] = useState("YES");
  const [target, setTarget] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!location) return;
    api<Sms[]>(`/portal/sms?locationId=${location.id}`).then((r) => {
      setRows(r);
      if (r.length > 0 && target === null) setTarget(r[r.length - 1].patientSourceId);
    }).catch(() => {});
    api<Email[]>(`/portal/email?locationId=${location.id}`).then(setEmails).catch(() => {});
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
      <PageTitle kicker="Simulator" title="Comms Console" />
      <p className="-mt-3 mb-4 max-w-2xl text-sm text-ink-soft">
        A stand-in for Twilio and SMTP. Agent outreach lands here; on the SMS tab, type a
        reply to act as the patient. Blocked and queued messages show their policy reason.
      </p>

      <div className="mb-4 flex gap-1">
        {(["sms", "email"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${
              tab === t ? "bg-pine text-white" : "border border-line text-ink-soft hover:border-teal hover:text-teal"
            }`}
          >
            {t === "sms" ? `SMS (${rows.length})` : `Email (${emails.length})`}
          </button>
        ))}
      </div>

      {tab === "sms" ? (
        <Card>
          {rows.length === 0 ? (
            <Empty text="No messages yet. Approve an outreach proposal first." />
          ) : (
            <div className="flex max-h-[30rem] flex-col gap-3 overflow-y-auto px-5 py-4">
              {rows.map((m) => {
                const policy = m.status ? POLICY_LABELS[m.status] : undefined;
                return (
                  <div key={m.id} className={`max-w-[34rem] ${m.direction === "outbound" ? "self-start" : "self-end"}`}>
                    <div className={`rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed shadow-sm ${
                      m.direction === "outbound"
                        ? policy?.startsWith("blocked")
                          ? "rounded-bl-sm bg-coral-soft text-coral line-through decoration-coral/50"
                          : "rounded-bl-sm bg-pine text-mint"
                        : "rounded-br-sm bg-mint text-pine"
                    }`}>
                      {m.body}
                    </div>
                    <div className={`mt-1 text-[10.5px] text-ink-faint ${m.direction === "inbound" ? "text-right" : ""}`}>
                      {m.direction === "outbound" ? "Clinic → " : "← "}
                      patient #{m.patientSourceId}
                      {m.patientLast ? ` (${m.patientLast}, ${m.patientFirst})` : ""} ·{" "}
                      {new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {policy && (
                        <span className={policy.startsWith("blocked") ? "text-coral" : "text-amber"}> · {policy}</span>
                      )}
                      {m.provider === "twilio" && (
                        <span className={m.status === "failed" ? "text-coral" : "text-teal"}>
                          {" "}· twilio {m.status}{m.error ? ` — ${m.error}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
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
              placeholder='Reply as the patient (try "YES", or "STOP" to opt out)'
            />
            <button onClick={send} className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white hover:bg-pine-2">
              Send
            </button>
          </div>
        </Card>
      ) : (
        <Card>
          {emails.length === 0 ? (
            <Empty text="No emails yet. Try a recall campaign (email-preferring patients), a statement notice, or an appeal." />
          ) : (
            <div className="flex max-h-[34rem] flex-col divide-y divide-line/50 overflow-y-auto">
              {emails.map((m) => {
                const policy = POLICY_LABELS[m.status];
                return (
                  <div key={m.id} className="px-5 py-3">
                    <button
                      className="block w-full text-left"
                      onClick={() => setOpenEmail(openEmail === m.id ? null : m.id)}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium">{m.subject}</span>
                        <span className="shrink-0 text-[10.5px] text-ink-faint">
                          {new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-faint">
                        to {m.toEmail || "—"}
                        {m.patientLast ? ` (${m.patientLast}, ${m.patientFirst})` : m.patientSourceId ? ` (patient #${m.patientSourceId})` : " (staff)"}
                        {" "}· {m.template} v{m.templateVersion} · {m.provider}
                        {policy
                          ? <span className={policy.startsWith("blocked") ? " text-coral" : " text-amber"}> · {policy}{m.error ? ` — ${m.error}` : ""}</span>
                          : <span className="text-teal"> · {m.status}</span>}
                      </div>
                    </button>
                    {openEmail === m.id && (
                      <div
                        className="mt-3 rounded-md border border-line bg-surface p-4"
                        dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}


export default function SmsPageGuarded() {
  return (
    <RequireRole roles={["admin", "billing", "staff"]} kicker="Simulator" title="Comms Console">
      <SmsPage />
    </RequireRole>
  );
}
