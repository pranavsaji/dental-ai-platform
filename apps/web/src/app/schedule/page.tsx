"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, Td, Th, fmtTime } from "@/components/ui";

interface ScheduleResp {
  date: string;
  operatories: Array<{ sourceId: number; name: string }>;
  appointments: Array<{
    sourceId: number; status: string; startsAt: string; minutes: number;
    procDescript: string; note: string; confirmed: boolean;
    operatorySourceId: number; patientSourceId: number;
    patientFirst: string | null; patientLast: string | null;
    providerAbbr: string | null; operatoryName: string | null;
  }>;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface EligBadge {
  patientSourceId: number;
  status: string; // verified | attention | inactive | failed
  summary: string;
  checkedAt: string;
}

// B2: green/amber/red insurance badge per schedule row, from the freshest
// eligibility check. Gray dot = never checked (sweep hasn't reached them).
function InsuranceDot({ check }: { check: EligBadge | undefined }) {
  const tone =
    !check ? "bg-line" :
    check.status === "verified" ? "bg-teal" :
    check.status === "attention" ? "bg-amber" :
    "bg-coral";
  const title = check
    ? `${check.status} — ${check.summary} (checked ${new Date(check.checkedAt).toLocaleDateString()})`
    : "insurance not verified yet";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone}`} title={title} />;
}

export default function SchedulePage() {
  const { location } = useApp();
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<ScheduleResp | null>(null);
  const [elig, setElig] = useState<Map<number, EligBadge>>(new Map());

  useEffect(() => {
    if (!location) return;
    setData(null);
    api<ScheduleResp>(`/portal/schedule?locationId=${location.id}&date=${date}`)
      .then((d) => {
        setData(d);
        const ids = [...new Set(d.appointments.map((a) => a.patientSourceId))];
        if (ids.length === 0) { setElig(new Map()); return; }
        api<EligBadge[]>(`/portal/billing/eligibility?locationId=${location.id}&patients=${ids.join(",")}`)
          .then((rows) => setElig(new Map(rows.map((r) => [r.patientSourceId, r]))))
          .catch(() => setElig(new Map()));
      })
      .catch(() => {});
  }, [location, date]);

  function shiftDay(delta: number) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  }

  return (
    <div>
      <PageTitle kicker="Operations" title="Schedule" />
      <div className="rise rise-1 mb-4 flex items-center gap-2">
        <button onClick={() => shiftDay(-1)} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-teal">←</button>
        <input
          type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-teal"
        />
        <button onClick={() => shiftDay(1)} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-teal">→</button>
        <button onClick={() => setDate(todayStr())} className="ml-2 text-xs font-medium text-teal hover:underline">Today</button>
      </div>

      <Card>
        {!data || data.appointments.length === 0 ? (
          <Empty text="No appointments on this date." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line/70">
                <tr>
                  <Th>Time</Th><Th>Len</Th><Th>Patient</Th><Th>Ins.</Th><Th>Procedure</Th><Th>Provider</Th><Th>Operatory</Th><Th>Conf.</Th><Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {data.appointments.map((a) => (
                  <tr key={a.sourceId} className={a.status === "broken" ? "bg-coral-soft/40" : "hover:bg-mint/25"}>
                    <Td className="num">{fmtTime(a.startsAt)}</Td>
                    <Td className="num text-ink-soft">{a.minutes}m</Td>
                    <Td>
                      <Link href={`/patients/${location!.id}/${a.patientSourceId}`} className="font-medium hover:text-teal">
                        {a.patientLast}, {a.patientFirst}
                      </Link>
                    </Td>
                    <Td><InsuranceDot check={elig.get(a.patientSourceId)} /></Td>
                    <Td className="text-ink-soft">{a.procDescript}</Td>
                    <Td>{a.providerAbbr ?? "—"}</Td>
                    <Td className="text-ink-soft">{a.operatoryName ?? "—"}</Td>
                    <Td>{a.confirmed ? "✓" : ""}</Td>
                    <Td><Chip value={a.status} /></Td>
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
