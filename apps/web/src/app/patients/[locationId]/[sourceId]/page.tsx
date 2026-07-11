"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, Chip, Empty, PageTitle, Td, Th, fmtDate, fmtMoney, fmtTime } from "@/components/ui";

interface Timeline {
  location: { id: number; key: string; name: string };
  patient: {
    firstName: string; lastName: string; birthdate: string | null; gender: string;
    status: string; wirelessPhone: string; email: string; address: string;
    city: string; state: string; zip: string; syncedAt: string;
  };
  appointments: Array<{ sourceId: number; status: string; startsAt: string; minutes: number; procDescript: string; note: string }>;
  procedures: Array<{ sourceId: number; procDate: string | null; fee: number; status: string; toothNum: string; procCode: string | null; description: string | null }>;
  notes: Array<{ sourceId: number; happenedAt: string; commType: number; note: string }>;
  claims: Array<{ sourceId: number; dateService: string | null; status: string; claimFee: number; insPayAmt: number }>;
  recall: { dateDue: string | null; datePrevious: string | null } | null;
  insurance: Array<{ ordinal: number; subscriberId: string; carrierName: string | null }>;
  // B3: pre-auth lifecycle per procedure — powers the chart badge.
  preauths: Array<{ procedureSourceId: number; status: string; missingItem: string }>;
}

const PREAUTH_CHIP: Record<string, string> = {
  approved: "bg-mint text-pine",
  denied: "bg-coral-soft text-coral",
  more_info: "bg-amber-soft text-amber",
  submitted: "bg-amber-soft text-amber",
  pending_approval: "bg-line/70 text-ink-soft",
  draft: "bg-line/70 text-ink-soft"
};

const COMM_TYPE: Record<number, string> = { 1: "Appointment", 2: "Billing", 3: "Clinical note", 4: "Text message" };

interface Previsit {
  summary: string;
  citedNoteIds: number[];
  usedLlm: boolean;
}

// B2: freshest eligibility verdict for the insurance card.
interface EligCheck {
  patientSourceId: number;
  status: string; // verified | attention | inactive | failed
  summary: string;
  checkedAt: string;
}

function daysAgo(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

export default function PatientPage({ params }: { params: Promise<{ locationId: string; sourceId: string }> }) {
  const { locationId, sourceId } = use(params);
  const [data, setData] = useState<Timeline | null>(null);
  const [previsit, setPrevisit] = useState<Previsit | null>(null);
  const [previsitBusy, setPrevisitBusy] = useState(false);
  const [elig, setElig] = useState<EligCheck | null>(null);
  const [stmtBusy, setStmtBusy] = useState(false);
  const [stmtMsg, setStmtMsg] = useState("");

  useEffect(() => {
    api<Timeline>(`/portal/patients/${locationId}/${sourceId}`).then(setData).catch(() => {});
    api<EligCheck[]>(`/portal/billing/eligibility?locationId=${locationId}&patients=${sourceId}`)
      .then((rows) => setElig(rows[0] ?? null))
      .catch(() => {});
  }, [locationId, sourceId]);

  // E3: statement/balance notice email (policy-gated — the outcome tells the
  // staff member whether it sent, queued for morning, or was blocked).
  async function emailStatement() {
    setStmtBusy(true);
    setStmtMsg("");
    try {
      const res = await api<{ outcome: string; reason: string | null }>(
        `/portal/billing/statement-email/${sourceId}?locationId=${locationId}`, { method: "POST" });
      setStmtMsg(res.outcome === "sent" ? "Statement emailed — see the Comms Console."
        : res.outcome === "queued" ? "Queued — sends at 8:00 patient time."
        : `Blocked: ${res.reason ?? "messaging policy"}.`);
    } catch (e: any) {
      setStmtMsg(`Failed: ${e.message ?? e}`);
    } finally {
      setStmtBusy(false);
    }
  }

  async function generatePrevisit() {
    setPrevisitBusy(true);
    setPrevisit(null);
    try {
      setPrevisit(await api<Previsit>(`/portal/ops/previsit/${locationId}/${sourceId}`, { method: "POST" }));
    } catch {
      setPrevisit({ summary: "Pre-visit summary failed — is the agents service running?", citedNoteIds: [], usedLlm: false });
    } finally {
      setPrevisitBusy(false);
    }
  }

  if (!data) return <div className="py-20 text-center text-sm text-ink-faint animate-pulse">Loading chart…</div>;
  const p = data.patient;

  return (
    <div>
      <PageTitle kicker={`Patient chart · ${data.location.name}`} title={`${p.lastName}, ${p.firstName}`} />
      <div className="rise rise-1 mb-6 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-ink-soft">
        <span>DOB <span className="num">{fmtDate(p.birthdate)}</span></span>
        <span>{p.gender}</span>
        <span className="num">{p.wirelessPhone}</span>
        <span>{p.email}</span>
        <span>{p.city}, {p.state}</span>
        <Chip value={p.status} />
        <span className="text-xs text-ink-faint">
          synced from OpenDental site {data.location.key.toUpperCase()} · {fmtTime(p.syncedAt)}
        </span>
      </div>

      <div className="rise rise-2 mb-5 rounded-lg border border-sage/60 bg-mint/25 p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-teal">Clinical agent</div>
            <div className="mt-0.5 text-sm text-ink-soft">
              Pre-visit huddle summary, grounded in this chart with note citations (pgvector RAG).
            </div>
          </div>
          <button
            onClick={generatePrevisit}
            disabled={previsitBusy}
            className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white hover:bg-pine-2 disabled:opacity-60"
          >
            {previsitBusy ? "Summarizing…" : "✳ Generate pre-visit summary"}
          </button>
        </div>
        {previsit && (
          <div className="mt-4 whitespace-pre-wrap rounded-md bg-surface px-4 py-3 text-[13.5px] leading-relaxed shadow-sm">
            {previsit.summary}
            {previsit.citedNoteIds.length > 0 && (
              <div className="mt-2 text-xs text-ink-faint">
                Cites notes: {previsit.citedNoteIds.join(", ")} · {previsit.usedLlm ? "Claude" : "no-LLM fallback"}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Appointments">
          {data.appointments.length === 0 ? <Empty text="None" /> : (
            <table className="w-full">
              <thead className="border-b border-line/70"><tr><Th>When</Th><Th>Procedure</Th><Th>Len</Th><Th>Status</Th></tr></thead>
              <tbody className="divide-y divide-line/50">
                {data.appointments.map((a) => (
                  <tr key={a.sourceId}>
                    <Td className="num">{fmtDate(a.startsAt)} {fmtTime(a.startsAt)}</Td>
                    <Td className="text-ink-soft">{a.procDescript}</Td>
                    <Td className="num">{a.minutes}m</Td>
                    <Td><Chip value={a.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Procedures">
          {data.procedures.length === 0 ? <Empty text="None" /> : (
            <table className="w-full">
              <thead className="border-b border-line/70"><tr><Th>Date</Th><Th>Code</Th><Th>Description</Th><Th>Tooth</Th><Th>Pre-auth</Th><Th className="text-right">Fee</Th></tr></thead>
              <tbody className="divide-y divide-line/50">
                {data.procedures.slice(0, 15).map((pr) => {
                  const pa = data.preauths?.find((x) => x.procedureSourceId === pr.sourceId);
                  return (
                    <tr key={pr.sourceId}>
                      <Td className="num">{fmtDate(pr.procDate)}</Td>
                      <Td className="num">{pr.procCode}</Td>
                      <Td className="text-ink-soft">{pr.description}</Td>
                      <Td className="num">{pr.toothNum || "—"}</Td>
                      <Td>
                        {pa ? (
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${PREAUTH_CHIP[pa.status] ?? "bg-line/70 text-ink-soft"}`}
                            title={pa.status === "more_info" && pa.missingItem ? `Payer needs: ${pa.missingItem}` : `Pre-authorization ${pa.status.replace(/_/g, " ")}`}
                          >
                            {pa.status === "approved" ? "cleared" : pa.status.replace(/_/g, " ")}
                          </span>
                        ) : ""}
                      </Td>
                      <Td className="num text-right">{fmtMoney(pr.fee)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Clinical notes & communications" className="xl:col-span-2">
          {data.notes.length === 0 ? <Empty text="None" /> : (
            <div className="divide-y divide-line/50">
              {data.notes.slice(0, 12).map((n) => (
                <div key={n.sourceId} className="px-5 py-3.5">
                  <div className="mb-1 flex items-center gap-3 text-xs text-ink-faint">
                    <span className="num">{fmtDate(n.happenedAt)}</span>
                    <span className="rounded-full bg-line/60 px-2 py-0.5">{COMM_TYPE[n.commType] ?? "Note"}</span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-ink-soft">{n.note}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Claims">
          {data.claims.length === 0 ? <Empty text="None" /> : (
            <table className="w-full">
              <thead className="border-b border-line/70"><tr><Th>Service</Th><Th>Status</Th><Th className="text-right">Billed</Th><Th className="text-right">Paid</Th></tr></thead>
              <tbody className="divide-y divide-line/50">
                {data.claims.map((c) => (
                  <tr key={c.sourceId}>
                    <Td className="num">{fmtDate(c.dateService)}</Td>
                    <Td><Chip value={c.status} /></Td>
                    <Td className="num text-right">{fmtMoney(c.claimFee)}</Td>
                    <Td className="num text-right">{fmtMoney(c.insPayAmt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recall & insurance">
          <div className="space-y-3 px-5 py-4 text-sm">
            <div>
              <span className="text-ink-faint">Hygiene recall due:</span>{" "}
              <span className="num font-medium">{fmtDate(data.recall?.dateDue ?? null)}</span>
              <span className="ml-2 text-xs text-ink-faint">(last visit {fmtDate(data.recall?.datePrevious ?? null)})</span>
            </div>
            {data.insurance.length === 0 ? (
              <div className="text-ink-faint">No insurance on file — self-pay.</div>
            ) : (
              data.insurance.map((i, idx) => (
                <div key={idx}>
                  <span className="font-medium">{i.carrierName}</span>
                  <span className="ml-2 text-xs text-ink-faint">subscriber <span className="num">{i.subscriberId}</span></span>
                </div>
              ))
            )}
            {/* B2: freshest eligibility verdict (same source as the /schedule dot). */}
            {data.insurance.length > 0 && (
              <div className="flex items-start gap-2 border-t border-line/50 pt-3">
                <span className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  !elig ? "bg-line" :
                  elig.status === "verified" ? "bg-teal" :
                  elig.status === "attention" ? "bg-amber" :
                  "bg-coral"
                }`} />
                {elig ? (
                  <div>
                    <span className="font-medium capitalize">{elig.status}</span>
                    <span className="ml-2 text-xs text-ink-faint">checked {daysAgo(elig.checkedAt)}</span>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-soft">{elig.summary}</p>
                  </div>
                ) : (
                  <span className="text-xs text-ink-faint">
                    Insurance not verified yet — run an eligibility sweep from Billing.
                  </span>
                )}
              </div>
            )}
            {/* E3: statement/balance notice over the email channel. */}
            <div className="border-t border-line/50 pt-3">
              <button
                onClick={emailStatement}
                disabled={stmtBusy}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-teal hover:text-teal disabled:opacity-50"
              >
                ✉ Email statement
              </button>
              {stmtMsg && <span className="ml-2 text-xs text-ink-faint">{stmtMsg}</span>}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
