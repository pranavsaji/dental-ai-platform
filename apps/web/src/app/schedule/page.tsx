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

export default function SchedulePage() {
  const { location } = useApp();
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<ScheduleResp | null>(null);

  useEffect(() => {
    if (!location) return;
    setData(null);
    api<ScheduleResp>(`/portal/schedule?locationId=${location.id}&date=${date}`)
      .then(setData).catch(() => {});
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
                  <Th>Time</Th><Th>Len</Th><Th>Patient</Th><Th>Procedure</Th><Th>Provider</Th><Th>Operatory</Th><Th>Conf.</Th><Th>Status</Th>
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
