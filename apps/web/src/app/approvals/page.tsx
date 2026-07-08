"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle } from "@/components/ui";

interface Action {
  id: number; workflowId: string; agent: string; type: string;
  summary: string; payload: any; status: string; createdAt: string;
  decidedBy: string | null;
}

export default function ApprovalsPage() {
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
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        AI agents propose; you dispose. Nothing touches a patient or the practice management
        system until a human approves it here (workflows park on a Temporal signal).
      </p>

      {pending.length === 0 && (
        <Card><Empty text="No pending proposals. Break an appointment in OpenDental and watch this queue." /></Card>
      )}

      <div className="grid gap-4">
        {pending.map((a) => (
          <div key={a.id} className="rise rounded-lg border-l-4 border-amber bg-surface p-5 shadow-[0_1px_3px_rgba(29,43,40,0.08)]">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="mb-1 flex items-center gap-2 text-xs text-ink-faint">
                  <span className="rounded-full bg-amber-soft px-2 py-0.5 font-medium text-amber">{a.agent} agent</span>
                  <span className="num">{a.type}</span>
                  <span>· workflow <span className="num">{a.workflowId.slice(0, 24)}…</span></span>
                </div>
                <p className="max-w-3xl text-[14.5px] leading-relaxed">{a.summary}</p>
                {a.payload?.message && (
                  <blockquote className="mt-3 max-w-2xl rounded-md bg-mint/40 px-4 py-3 text-[13.5px] italic leading-relaxed text-pine">
                    “{a.payload.message}”
                  </blockquote>
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
