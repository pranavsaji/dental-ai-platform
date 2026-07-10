"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, Td, Th, fmtDate } from "@/components/ui";

interface Task {
  id: number;
  type: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "done" | "dismissed";
  assigneeRole: string | null;
  assigneeUserId: number | null;
  createdBy: string;
  workflowId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  resolvedBy: string | null;
}

const PRIORITY_STYLES: Record<Task["priority"], string> = {
  urgent: "bg-coral-soft text-coral",
  high: "bg-amber-soft text-amber",
  normal: "bg-mint text-pine",
  low: "bg-line/70 text-ink-soft"
};

const TYPE_LABELS: Record<string, string> = {
  eligibility_failure: "Eligibility",
  claim_denial: "Claim denial",
  patient_question: "Patient question",
  huddle_action: "Huddle action",
  preauth_required: "Pre-auth",
  manual: "Manual"
};

function deepLink(t: Task, locationId: number): string | null {
  if (!t.resourceType || !t.resourceId) return null;
  if (t.resourceType === "patient") return `/patients/${locationId}/${t.resourceId}`;
  return null;
}

export default function TasksPage() {
  const { location, user } = useApp();
  const [rows, setRows] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!location) return;
    const params = new URLSearchParams({ locationId: String(location.id) });
    if (typeFilter) params.set("type", typeFilter);
    api<Task[]>(`/portal/tasks?${params}`).then(setRows).catch(() => {});
  }, [location, typeFilter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function act(id: number, action: "claim" | "done" | "dismissed") {
    if (!location) return;
    setBusy(id);
    try {
      if (action === "claim") {
        await api(`/portal/tasks/${id}/claim?locationId=${location.id}`, { method: "POST" });
      } else {
        await api(`/portal/tasks/${id}/resolve?locationId=${location.id}`, {
          method: "POST",
          body: JSON.stringify({ outcome: action })
        });
      }
      load();
    } finally {
      setBusy(null);
    }
  }

  const visible = rows.filter((t) =>
    statusFilter === "active" ? t.status === "open" || t.status === "in_progress" :
    statusFilter === "" ? true : t.status === statusFilter);
  const types = [...new Set(rows.map((t) => t.type))].sort();

  return (
    <div>
      <PageTitle kicker="Work queue" title="Tasks" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Everything that needs a human: eligibility exceptions, denials, patient questions, and
        workflow escalations land here as durable, assignable work — with the audit trail to match.
      </p>

      <div className="rise rise-1 mb-4 flex items-center gap-3">
        <select
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm shadow-sm outline-none focus:border-teal"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="active">Open + in progress</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
          <option value="dismissed">Dismissed</option>
          <option value="">All</option>
        </select>
        <select
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm shadow-sm outline-none focus:border-teal"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
      </div>

      <Card>
        {visible.length === 0 ? (
          <Empty text="No tasks match this filter. Workflow escalations and exceptions will appear here." />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line/70">
                <Th>Priority</Th>
                <Th>Task</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {visible.map((t) => {
                const link = deepLink(t, location!.id);
                return (
                  <tr key={t.id}>
                    <Td>
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${PRIORITY_STYLES[t.priority]}`}>
                        {t.priority}
                      </span>
                    </Td>
                    <Td>
                      <div className="font-medium">
                        {link ? (
                          <Link href={link} className="underline-offset-2 hover:text-teal hover:underline">{t.title}</Link>
                        ) : t.title}
                      </div>
                      {t.body && <div className="mt-0.5 max-w-xl text-xs leading-relaxed text-ink-soft">{t.body}</div>}
                      <div className="mt-0.5 text-[11px] text-ink-faint">
                        by {t.createdBy}
                        {t.resourceType && !link && <> · {t.resourceType} <span className="num">{t.resourceId}</span></>}
                        {t.workflowId && <> · workflow <span className="num">{t.workflowId.slice(0, 20)}…</span></>}
                      </div>
                    </Td>
                    <Td>{TYPE_LABELS[t.type] ?? t.type}</Td>
                    <Td><Chip value={t.status === "in_progress" ? "pending" : t.status === "done" ? "complete" : t.status} />
                      {t.status === "in_progress" && t.assigneeUserId === user.sub && (
                        <span className="ml-1 text-[11px] text-ink-faint">(you)</span>
                      )}
                    </Td>
                    <Td className="text-ink-soft">{fmtDate(t.createdAt)}</Td>
                    <Td className="text-right">
                      {(t.status === "open" || t.status === "in_progress") && (
                        <div className="flex justify-end gap-2">
                          {t.status === "open" && (
                            <button
                              disabled={busy === t.id}
                              onClick={() => act(t.id, "claim")}
                              className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-teal hover:text-teal disabled:opacity-50"
                            >
                              Claim
                            </button>
                          )}
                          <button
                            disabled={busy === t.id}
                            onClick={() => act(t.id, "done")}
                            className="rounded-md bg-pine px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
                          >
                            Resolve
                          </button>
                          <button
                            disabled={busy === t.id}
                            onClick={() => act(t.id, "dismissed")}
                            className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-coral hover:text-coral disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
