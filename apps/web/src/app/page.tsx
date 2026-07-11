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
  unscheduledTreatment: number;
  unscheduledTreatmentValue: number;
}

// C1: the digest row from /portal/ops/huddle.
interface Huddle {
  date: string;
  narrative: string;
  actionItems: Array<{ title: string; priority: string; taskType: string }>;
  usedLlm: boolean;
  createdAt: string;
}

interface ScheduleResp {
  date: string;
  appointments: Array<{
    sourceId: number; status: string; startsAt: string; minutes: number;
    procDescript: string; patientFirst: string | null; patientLast: string | null;
    providerAbbr: string | null; operatoryName: string | null; patientSourceId: number;
  }>;
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function OverviewPage() {
  const { location } = useApp();
  const [ov, setOv] = useState<Overview | null>(null);
  const [sched, setSched] = useState<ScheduleResp | null>(null);
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [huddleDate, setHuddleDate] = useState(() => localDateStr(new Date()));
  const [opsMsg, setOpsMsg] = useState("");
  const [taskMsg, setTaskMsg] = useState("");
  const today = localDateStr(new Date());

  function shiftHuddleDate(delta: number) {
    const d = new Date(`${huddleDate}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setHuddle(null); // don't show one day's digest under another day's header
    setHuddleDate(localDateStr(d));
  }

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

  // E3: email the visible digest to the signed-in user (huddle_digest template).
  async function emailHuddle() {
    if (!location) return;
    try {
      await api(`/portal/ops/huddle-email?locationId=${location.id}&date=${huddleDate}`, { method: "POST" });
      setOpsMsg("Huddle digest emailed — see the Email tab of the Comms Console.");
    } catch (e: any) {
      setOpsMsg(`Email failed: ${e.message ?? e}`);
    }
  }

  // C1: one-click task from a huddle action item.
  async function createHuddleTask(item: { title: string; priority: string; taskType: string }) {
    if (!location) return;
    try {
      await api(`/portal/tasks`, {
        method: "POST",
        body: JSON.stringify({
          locationId: location.id,
          type: item.taskType || "huddle_action",
          title: item.title,
          priority: item.priority,
          body: `From the ${huddle?.date ?? ""} morning huddle.`
        })
      });
      setTaskMsg(`Task created: ${item.title}`);
    } catch (e: any) {
      setTaskMsg(`Could not create task: ${e.message ?? e}`);
    }
  }

  useEffect(() => {
    if (!location) return;
    const loadHuddle = () =>
      api<{ digest: Huddle | null }>(`/portal/ops/huddle?locationId=${location.id}&date=${huddleDate}`)
        .then((r) => setHuddle(r.digest))
        .catch(() => {});
    api<Overview>(`/portal/overview?locationId=${location.id}`).then(setOv).catch(() => {});
    api<ScheduleResp>(`/portal/schedule?locationId=${location.id}`).then(setSched).catch(() => {});
    loadHuddle();
    const t = setInterval(() => {
      api<Overview>(`/portal/overview?locationId=${location.id}`).then(setOv).catch(() => {});
      loadHuddle();
    }, 15000);
    return () => clearInterval(t);
  }, [location, huddleDate]);

  return (
    <div>
      <PageTitle kicker="Control plane" title={location?.name ?? ""} />

      {/* C1: morning huddle digest */}
      <Card
        title={`Morning huddle — ${huddleDate}`}
        className="rise mb-6"
        action={
          <div className="flex items-center gap-2">
            {huddle && (
              <span className="text-[11px] text-ink-faint">
                {huddle.usedLlm ? "agent narrative" : "template narrative"}
              </span>
            )}
            {/* Digest history: one row per (location, day) — page by date. */}
            <button
              onClick={() => shiftHuddleDate(-1)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:border-teal"
              title="Previous day's digest"
            >
              ←
            </button>
            <button
              onClick={() => shiftHuddleDate(1)}
              disabled={huddleDate >= today}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs hover:border-teal disabled:opacity-40"
              title="Next day's digest"
            >
              →
            </button>
            {huddleDate !== today && (
              <button onClick={() => setHuddleDate(today)} className="text-xs font-medium text-teal hover:underline">
                Today
              </button>
            )}
            {huddle && (
              <button
                onClick={() => emailHuddle()}
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs hover:border-teal hover:text-teal"
                title="Email this digest to yourself (E3 huddle_digest template)"
              >
                ✉ Email me
              </button>
            )}
            {huddleDate === today && (
              <button
                onClick={() => runOps("huddle", "Morning huddle")}
                className="rounded-md bg-pine px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-2"
              >
                ✳ {huddle ? "Refresh digest" : "Generate digest"}
              </button>
            )}
          </div>
        }
      >
        {!huddle ? (
          <Empty text={huddleDate === today
            ? "No digest yet today. The cron runs at 6:00 — or generate one now."
            : `No digest was generated on ${huddleDate}.`} />
        ) : (
          <div className="px-5 py-4">
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{huddle.narrative}</p>
            {huddle.actionItems.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {huddle.actionItems.map((a, i) => (
                  <li key={i} className="flex items-center gap-3 text-[13px]">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                      a.priority === "high" || a.priority === "urgent" ? "bg-coral" : "bg-teal"
                    }`} />
                    <span className="flex-1">{a.title}</span>
                    <button
                      onClick={() => createHuddleTask(a)}
                      className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-soft hover:border-teal hover:text-teal"
                    >
                      → task
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {taskMsg && <div className="mt-3 text-xs text-teal">{taskMsg}</div>}
          </div>
        )}
      </Card>

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
        <StatTile
          label="Unscheduled treatment" value={ov ? fmtMoney(ov.unscheduledTreatmentValue) : "—"}
          detail={ov ? `${ov.unscheduledTreatment} planned procedures without a visit` : undefined}
          tone={ov && ov.unscheduledTreatmentValue > 0 ? "warn" : "good"} delay="rise-3"
        />
        <div className="rise rise-4 flex flex-col justify-center gap-2 rounded-lg border border-dashed border-sage/70 bg-mint/20 px-5 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-teal">Agent operations</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => runOps("recall-campaign", "Recall campaign")}
              className="rounded-md bg-pine px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-pine-2"
            >
              ✳ Recall campaign
            </button>
            <button
              onClick={() => runOps("treatment-outreach", "Treatment outreach")}
              className="rounded-md bg-pine px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-pine-2"
            >
              ✳ Treatment outreach
            </button>
            <button
              onClick={() => runOps("reminder-sweep", "Reminder sweep")}
              className="rounded-md border border-pine/30 bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-pine hover:border-teal"
            >
              ✳ Reminder sweep
            </button>
            <button
              onClick={() => runOps("claim-followup", "Claim follow-up")}
              className="rounded-md border border-pine/30 bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-pine hover:border-teal"
            >
              ✳ Claim follow-up
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
