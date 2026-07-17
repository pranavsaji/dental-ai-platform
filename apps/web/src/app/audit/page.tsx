"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, Empty, PageTitle, Td, Th } from "@/components/ui";
import { RequireRole } from "@/components/require-role";

interface AuditRow {
  id: number; actorType: string; actor: string; action: string;
  resource: string; resourceId: string; purpose: string; at: string;
}

// G2: result of GET /portal/audit/verify (F2's tamper-evidence check).
interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtId: number | null;
  detail: string;
  anchor: { id: number; entryHash: string } | null;
}

const ACTOR_TONE: Record<string, string> = {
  user: "bg-mint text-pine",
  agent: "bg-amber-soft text-amber",
  edge: "bg-line/70 text-ink-soft",
  system: "bg-line/70 text-ink-soft"
};

function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  // G2: the hash-chain check, previously API-only. The endpoint audits the
  // verification itself, so the refreshed table shows this click too.
  async function runVerify() {
    setVerifying(true);
    setVerify(null);
    try {
      setVerify(await api<ChainVerification>("/portal/audit/verify"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

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
      <p className="-mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Append-only record of every PHI access and mutation across users, AI agents, and edge
        synchronizers. Synthetic data only — this demonstrates the HIPAA audit-control pattern.
      </p>

      {/* G2: tamper-evidence check — each entry's hash commits to the previous
          one, so edits, deletions, or reordering are detectable on demand
          (a nightly cron runs the same walk and raises an urgent task on
          breakage). */}
      <div className="mb-4 flex items-center gap-4">
        <button
          disabled={verifying}
          onClick={() => void runVerify()}
          className="rounded-md bg-pine px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
        >
          {verifying ? "Verifying…" : "⛓ Verify chain"}
        </button>
        {verify && (
          verify.ok ? (
            <span className="rounded-md border border-teal/40 bg-mint/40 px-3 py-1.5 text-xs text-pine">
              Chain intact — {verify.checked} hashed {verify.checked === 1 ? "entry" : "entries"} verified
              {verify.anchor && (
                <span className="num ml-1 text-pine/70">
                  · anchor #{verify.anchor.id} {verify.anchor.entryHash.slice(0, 16)}…
                </span>
              )}
            </span>
          ) : (
            <span className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs font-medium text-coral">
              Chain broken at entry #{verify.brokenAtId}: {verify.detail}
            </span>
          )
        )}
      </div>

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


export default function AuditPageGuarded() {
  return (
    <RequireRole roles={["admin"]} kicker="Compliance" title="Audit Trail">
      <AuditPage />
    </RequireRole>
  );
}
