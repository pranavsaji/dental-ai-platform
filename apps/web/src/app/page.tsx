"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, StatTile, Td, Th, fmtMoney, fmtTime } from "@/components/ui";
import { m, AnimatePresence, StaggerList, StaggerItem } from "@/components/motion/motion";
import { fadeSwap } from "@/components/motion/presets";
import { StatTileSkeleton, TableSkeleton } from "@/components/skeleton";
import { AmbientBackdrop } from "@/components/three/ambient-backdrop-lazy";

interface Overview {
  location: { id: number; key: string; name: string };
  todayScheduled: number;
  upcoming7d: number;
  broken7d: number;
  activePatients: number;
  overdueRecalls: number;
  openClaims: number;
  // Dollar figures are null for roles without billing access (provider/staff).
  openClaimsValue: number | null;
  unscheduledTreatment: number;
  unscheduledTreatmentValue: number | null;
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

// The one-click agent workflows, described in the user's terms: what the agent
// does and where the output lands. `who` mirrors the API matrix (roles.ts) —
// campaigns are front-desk work, claim chasing is billing work.
const AGENT_OPS: Array<{ path: string; name: string; desc: string; who: "campaign" | "billing" }> = [
  {
    path: "recall-campaign", name: "Recall campaign", who: "campaign",
    desc: "Finds patients overdue for hygiene recall and drafts a text offering open slots."
  },
  {
    path: "treatment-outreach", name: "Treatment outreach", who: "campaign",
    desc: "Reaches out to patients whose planned treatment never got scheduled."
  },
  {
    path: "reminder-sweep", name: "Reminder sweep", who: "campaign",
    desc: "Prepares tomorrow's appointment reminders for review (or auto-send, per location policy)."
  },
  {
    path: "claim-followup", name: "Claim follow-up", who: "billing",
    desc: "Picks the oldest open insurance claim, checks it with the payer, and logs the outcome."
  }
];

export default function OverviewPage() {
  const { location, user } = useApp();
  // Mirrors the API matrix: campaign sends are front-desk work, claim
  // follow-up is billing work. Buttons a role can't use aren't rendered.
  const canCampaign = user.role === "admin" || user.role === "staff";
  const canBillingOps = user.role === "admin" || user.role === "billing";
  const canHuddle = user.role !== "billing"; // huddle.run: admin|provider|staff
  const visibleOps = AGENT_OPS.filter((op) =>
    op.who === "campaign" ? canCampaign : canBillingOps);
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
    <div className="relative">
      <AmbientBackdrop height={360} />
      <PageTitle kicker="Control plane" title={location?.name ?? ""} />

      {/* C1: morning huddle digest */}
      <Card
        title={`Morning huddle — ${huddleDate}`}
        className="mb-6"
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
            {huddle && canHuddle && (
              <button
                onClick={() => emailHuddle()}
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs hover:border-teal hover:text-teal"
                title="Email this digest to yourself (E3 huddle_digest template)"
              >
                ✉ Email me
              </button>
            )}
            {huddleDate === today && canHuddle && (
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
        <AnimatePresence mode="wait" initial={false}>
        {!huddle ? (
          <m.div key={`empty-${huddleDate}`} variants={fadeSwap} initial="hidden" animate="show" exit="exit">
            <Empty text={huddleDate === today
              ? "No digest yet today. The cron runs at 6:00 — or generate one now."
              : `No digest was generated on ${huddleDate}.`} />
          </m.div>
        ) : (
          <m.div key={huddleDate} variants={fadeSwap} initial="hidden" animate="show" exit="exit" className="px-5 py-4">
            <p className="max-w-3xl text-sm leading-relaxed text-ink">{huddle.narrative}</p>
            {huddle.actionItems.length > 0 && (
              <StaggerList className="mt-4 space-y-1.5">
                {huddle.actionItems.map((a, i) => (
                  <StaggerItem key={i} className="flex items-center gap-3 text-[13px]">
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
                  </StaggerItem>
                ))}
              </StaggerList>
            )}
            {taskMsg && <div className="mt-3 text-xs text-teal">{taskMsg}</div>}
          </m.div>
        )}
        </AnimatePresence>
      </Card>

      {!ov ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => <StatTileSkeleton key={i} />)}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => <StatTileSkeleton key={i} />)}
          </div>
        </>
      ) : (
        <>
          <StaggerList className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StaggerItem>
              <StatTile label="Scheduled today" value={ov.todayScheduled} detail="confirmed & unconfirmed" />
            </StaggerItem>
            <StaggerItem>
              <StatTile label="Next 7 days" value={ov.upcoming7d} detail="upcoming appointments" />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Broken · 7 days" value={ov.broken7d}
                detail="cancellations detected via edge sync"
                tone={ov.broken7d > 0 ? "alert" : "default"}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Overdue recalls" value={ov.overdueRecalls}
                detail="reactivation candidates"
                tone={ov.overdueRecalls > 0 ? "warn" : "default"}
              />
            </StaggerItem>
          </StaggerList>
          <StaggerList className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
            <StaggerItem>
              <StatTile label="Active patients" value={ov.activePatients} />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Open claims" value={ov.openClaims}
                detail={ov.openClaimsValue != null ? `${fmtMoney(ov.openClaimsValue)} outstanding` : undefined}
                tone={ov.openClaims > 0 ? "warn" : "default"}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Unscheduled treatment"
                value={ov.unscheduledTreatmentValue != null ? ov.unscheduledTreatmentValue : ov.unscheduledTreatment}
                format={ov.unscheduledTreatmentValue != null ? fmtMoney : undefined}
                detail={`${ov.unscheduledTreatment} planned procedures without a visit`}
                tone={ov.unscheduledTreatment > 0 ? "warn" : "good"}
              />
            </StaggerItem>
          </StaggerList>
        </>
      )}

      {visibleOps.length > 0 && (
        <div className="mt-8">
          <Card
            title="Agent operations"
            action={<span className="text-xs text-ink-faint">Every run is audited · patient messages wait in Approvals</span>}
          >
            <p className="border-b border-line/60 px-5 pb-3 pt-4 text-[13px] leading-relaxed text-ink-soft">
              One-click AI workflows for this location. Each one drafts its own patient
              outreach or payer follow-up; nothing reaches a patient without approval
              unless this location's policy allows auto-send.
            </p>
            <div className="grid grid-cols-1 divide-y divide-line/50 md:grid-cols-2 md:divide-y-0">
              {visibleOps.map((op) => (
                <div
                  key={op.path}
                  className="group relative flex items-center gap-4 overflow-hidden px-5 py-4"
                >
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0 bg-mint/30 transition-all duration-300 group-hover:w-full"
                  />
                  <div className="relative min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold text-ink">{op.name}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-ink-faint">{op.desc}</div>
                  </div>
                  <m.button
                    whileTap={{ scale: 0.96 }}
                    onClick={() => runOps(op.path, op.name)}
                    className="relative shrink-0 rounded-md bg-pine px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-pine-2 hover:shadow-[var(--shadow-sm)]"
                  >
                    ✳ Run
                  </m.button>
                </div>
              ))}
            </div>
            <AnimatePresence>
              {opsMsg && (
                <m.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden border-t border-line/60 bg-mint/20"
                >
                  <div className="px-5 py-2.5 text-xs text-ink-soft">{opsMsg}</div>
                </m.div>
              )}
            </AnimatePresence>
          </Card>
        </div>
      )}

      <div className="mt-8 grid gap-5">
        <Card
          title={`Today — ${sched?.date ?? ""}`}
          action={<Link href="/schedule" className="text-xs font-medium text-teal hover:underline">Full schedule →</Link>}
        >
          {!sched ? (
            <TableSkeleton rows={5} cols={6} />
          ) : sched.appointments.length === 0 ? (
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
