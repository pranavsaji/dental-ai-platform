"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, Empty, PageTitle, Td, Th } from "@/components/ui";

interface AuditRow {
  id: number; actorType: string; actor: string; action: string;
  resource: string; resourceId: string; purpose: string; at: string;
}

const ACTOR_TONE: Record<string, string> = {
  user: "bg-mint text-pine",
  agent: "bg-amber-soft text-amber",
  edge: "bg-line/70 text-ink-soft",
  system: "bg-line/70 text-ink-soft"
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () =>
      api<AuditRow[]>("/portal/audit?limit=200").then(setRows)
        .catch((e) => setError(e.status === 403 ? "Audit trail requires the admin or provider role." : ""));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <PageTitle kicker="Compliance" title="Audit Trail" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Append-only record of every PHI access and mutation across users, AI agents, and edge
        synchronizers. Synthetic data only — this demonstrates the HIPAA audit-control pattern.
      </p>
      <Card>
        {error ? <Empty text={error} /> : rows.length === 0 ? <Empty text="No audit entries yet." /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line/70">
                <tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Resource</Th><Th>Purpose</Th></tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-mint/25">
                    <Td className="num whitespace-nowrap text-ink-soft">
                      {new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}
                    </Td>
                    <Td>
                      <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-medium ${ACTOR_TONE[r.actorType] ?? ""}`}>
                        {r.actorType}
                      </span>
                      <span className="text-ink-soft">{r.actor}</span>
                    </Td>
                    <Td className="num text-[12.5px]">{r.action}</Td>
                    <Td className="text-ink-soft">{r.resource}{r.resourceId ? ` #${r.resourceId}` : ""}</Td>
                    <Td className="text-ink-faint">{r.purpose}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
