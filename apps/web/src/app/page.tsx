"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, StatTile, Td, Th, fmtMoney, fmtTime } from "@/components/ui";

interface Overview {
  location: { id: number; key: string; name: string };
  todayScheduled: number;
  upcoming7d: number;
  broken7d: number;
  activePatients: number;
  overdueRecalls: number;
  openClaims: number;
  openClaimsValue: number;
}

interface ScheduleResp {
  date: string;
  appointments: Array<{
    sourceId: number; status: string; startsAt: string; minutes: number;
    procDescript: string; patientFirst: string | null; patientLast: string | null;
    providerAbbr: string | null; operatoryName: string | null; patientSourceId: number;
  }>;
}

export default function OverviewPage() {
  const { location } = useApp();
  const [ov, setOv] = useState<Overview | null>(null);
  const [sched, setSched] = useState<ScheduleResp | null>(null);
  const [opsMsg, setOpsMsg] = useState("");

  async function runOps(path: string, label: string) {
    if (!location) return;
    setOpsMsg(`Starting ${label}…`);
    try {
      const res = await api<{ workflowId: string }>(`/portal/ops/${path}?locationId=${location.id}`, { method: "POST" });
      setOpsMsg(`${label} started (workflow ${res.workflowId}). Check Approvals in a few seconds.`);
    } catch (e: any) {
      setOpsMsg(`${label} failed: ${e.message ?? e}`);
    }
  }

  useEffect(() => {
    if (!location) return;
    api<Overview>(`/portal/overview?locationId=${location.id}`).then(setOv).catch(() => {});
    api<ScheduleResp>(`/portal/schedule?locationId=${location.id}`).then(setSched).catch(() => {});
    const t = setInterval(() => {
      api<Overview>(`/portal/overview?locationId=${location.id}`).then(setOv).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [location]);

  return (
    <div>
      <PageTitle kicker="Control plane" title={location?.name ?? ""} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Scheduled today" value={ov?.todayScheduled ?? "—"} detail="confirmed & unconfirmed" delay="rise-1" />
        <StatTile label="Next 7 days" value={ov?.upcoming7d ?? "—"} detail="upcoming appointments" delay="rise-2" />
        <StatTile
          label="Broken · 7 days" value={ov?.broken7d ?? "—"}
          detail="cancellations detected via edge sync"
          tone={ov && ov.broken7d > 0 ? "alert" : "default"} delay="rise-3"
        />
        <StatTile
          label="Overdue recalls" value={ov?.overdueRecalls ?? "—"}
          detail="reactivation candidates"
          tone={ov && ov.overdueRecalls > 0 ? "warn" : "default"} delay="rise-4"
        />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Active patients" value={ov?.activePatients ?? "—"} delay="rise-2" />
        <StatTile
          label="Open claims" value={ov?.openClaims ?? "—"}
          detail={ov ? `${fmtMoney(ov.openClaimsValue)} outstanding` : undefined}
          tone={ov && ov.openClaims > 0 ? "warn" : "default"} delay="rise-3"
        />
        <div className="rise rise-4 col-span-2 flex flex-col justify-center gap-2 rounded-lg border border-dashed border-sage/70 bg-mint/20 px-5 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-teal">Agent operations</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => runOps("recall-campaign", "Recall campaign")}
              className="rounded-md bg-pine px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-pine-2"
            >
              ✳ Run recall campaign
            </button>
            <button
              onClick={() => runOps("claim-followup", "Claim follow-up")}
              className="rounded-md border border-pine/30 bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-pine hover:border-teal"
            >
              ✳ Run claim follow-up
            </button>
          </div>
          {opsMsg && <div className="text-xs text-ink-soft">{opsMsg}</div>}
        </div>
      </div>

      <div className="mt-8 grid gap-5">
        <Card
          title={`Today — ${sched?.date ?? ""}`}
          action={<Link href="/schedule" className="text-xs font-medium text-teal hover:underline">Full schedule →</Link>}
        >
          {!sched || sched.appointments.length === 0 ? (
            <Empty text="No appointments today." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-line/70">
                  <tr>
                    <Th>Time</Th><Th>Patient</Th><Th>Procedure</Th><Th>Provider</Th><Th>Operatory</Th><Th>Status</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {sched.appointments.map((a) => (
                    <tr key={a.sourceId} className="hover:bg-mint/25">
                      <Td className="num">{fmtTime(a.startsAt)}</Td>
                      <Td>
                        <Link href={`/patients/${location!.id}/${a.patientSourceId}`} className="font-medium hover:text-teal">
                          {a.patientLast}, {a.patientFirst}
                        </Link>
                      </Td>
                      <Td className="text-ink-soft">{a.procDescript}</Td>
                      <Td>{a.providerAbbr ?? "—"}</Td>
                      <Td className="text-ink-soft">{a.operatoryName ?? "—"}</Td>
                      <Td><Chip value={a.status} /></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
