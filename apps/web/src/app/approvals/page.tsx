"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle } from "@/components/ui";
import { RequireRole } from "@/components/require-role";

interface Action {
  id: number; workflowId: string; agent: string; type: string;
  summary: string; payload: any; status: string; createdAt: string;
  decidedBy: string | null;
}

function ApprovalsPage() {
  const { location } = useApp();
  const [rows, setRows] = useState<Action[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!location) return;
    api<Action[]>(`/portal/actions?locationId=${location.id}`).then(setRows).catch(() => {});
  }, [location]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function decide(id: number, decision: "approved" | "rejected") {
    setBusy(id);
    try {
      await api(`/portal/actions/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
      load();
    } finally {
      setBusy(null);
    }
  }

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div>
      <PageTitle kicker="Human in the loop" title="Agent Approvals" />
      <p className="-mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        AI agents propose; you dispose. Nothing touches a patient or the practice management
        system until a human approves it here (workflows park on a Temporal signal).
      </p>

      {pending.length === 0 && (
        <Card><Empty text="No pending proposals. Break an appointment in OpenDental and watch this queue." /></Card>
      )}

      <div className="grid gap-4">
        {pending.map((a) => (
          <div key={a.id} className="rounded-lg border-l-4 border-amber bg-surface p-5 shadow-[0_1px_3px_rgba(29,43,40,0.08)]">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs text-ink-faint">
                  <span className="rounded-full bg-amber-soft px-2 py-0.5 font-medium text-amber">{a.agent} agent</span>
                  <span className="num">{a.type}</span>
                  <span>· workflow <span className="num">{a.workflowId.slice(0, 24)}…</span></span>
                </div>
                <p className="max-w-3xl text-[14.5px] leading-relaxed">{a.summary}</p>
                {a.payload?.message && !Array.isArray(a.payload?.recipients) && (
                  <blockquote className="mt-3 max-w-2xl rounded-md bg-mint/40 px-4 py-3 text-[13.5px] italic leading-relaxed text-pine">
                    “{a.payload.message}”
                  </blockquote>
                )}
                {/* Batch cards (reminders, treatment outreach, recall): the
                    reviewer sees every message before anything sends. */}
                {Array.isArray(a.payload?.recipients) && a.payload.recipients.length > 0 && (
                  <div className="mt-3 max-w-2xl space-y-1.5">
                    {a.payload.recipients.slice(0, 5).map((r: any, i: number) => (
                      <div key={i} className="rounded-md bg-mint/30 px-3 py-2 text-[12.5px] leading-relaxed text-pine">
                        <span className="font-semibold">{r.patientName ?? `Patient ${r.patientSourceId}`}:</span>{" "}
                        <span className="italic">“{r.message}”</span>
                      </div>
                    ))}
                    {a.payload.recipients.length > 5 && (
                      <div className="text-[11px] text-ink-faint">
                        + {a.payload.recipients.length - 5} more recipient{a.payload.recipients.length - 5 === 1 ? "" : "s"} in this batch
                      </div>
                    )}
                  </div>
                )}
                {/* Backfill cascade (C3): one approval covers the ordered list. */}
                {Array.isArray(a.payload?.cascade) && a.payload.cascade.length > 1 && (
                  <div className="mt-2 text-[12px] text-ink-soft">
                    Cascade order: {a.payload.cascade.map((c: any) => c.patientName).join(" → ")}
                    <span className="text-ink-faint"> (next candidate is texted only if the previous declines or times out)</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  disabled={busy === a.id}
                  onClick={() => decide(a.id, "approved")}
                  className="rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  disabled={busy === a.id}
                  onClick={() => decide(a.id, "rejected")}
                  className="rounded-md border border-line px-4 py-2 text-sm text-ink-soft hover:border-coral hover:text-coral disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {decided.length > 0 && (
        <Card title="Recent decisions" className="mt-6">
          <div className="divide-y divide-line/50">
            {decided.slice(0, 15).map((a) => (
              <div key={a.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <Chip value={a.status} />
                  <span className="text-ink-soft">{a.summary.slice(0, 110)}</span>
                </div>
                <span className="text-xs text-ink-faint">{a.decidedBy ?? ""}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}


export default function ApprovalsPageGuarded() {
  return (
    <RequireRole roles={["admin", "billing", "staff"]} kicker="Human in the loop" title="Agent Approvals">
      <ApprovalsPage />
    </RequireRole>
  );
}
