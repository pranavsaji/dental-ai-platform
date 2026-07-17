"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, Td, Th, fmtDate } from "@/components/ui";

interface PatientRow {
  sourceId: number; firstName: string; lastName: string;
  birthdate: string | null; wirelessPhone: string; email: string;
  city: string; status: string;
}

interface ChartHit {
  noteId: number;
  patientSourceId: number;
  patientName: string | null;
  content: string;
  similarity: number;
}

export default function PatientsPage() {
  const { location } = useApp();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [semantic, setSemantic] = useState("");
  const [hits, setHits] = useState<ChartHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function runSemantic() {
    if (!location || !semantic.trim()) return;
    setSearching(true);
    try {
      setHits(await api<ChartHit[]>("/portal/ops/chart-search", {
        method: "POST",
        body: JSON.stringify({ locationId: location.id, query: semantic })
      }));
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!location) return;
    const t = setTimeout(() => {
      api<PatientRow[]>(`/portal/patients?locationId=${location.id}&q=${encodeURIComponent(q)}`)
        .then(setRows).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [location, q]);

  return (
    <div>
      <PageTitle kicker="Records" title="Patients" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          placeholder="Search by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-80 rounded-md border border-line bg-surface px-4 py-2 text-sm shadow-sm outline-none focus:border-teal"
        />
        <div className="flex items-center gap-2">
          <input
            placeholder='Ask the charts… e.g. "molar root canal with lingering pain"'
            value={semantic}
            onChange={(e) => setSemantic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSemantic()}
            className="w-96 rounded-md border border-sage/70 bg-mint/20 px-4 py-2 text-sm shadow-sm outline-none focus:border-teal"
          />
          <button
            onClick={runSemantic}
            disabled={searching}
            className="rounded-md bg-pine px-3.5 py-2 text-sm font-semibold text-white hover:bg-pine-2 disabled:opacity-60"
          >
            {searching ? "Searching…" : "✳ Semantic"}
          </button>
        </div>
      </div>

      {hits && (
        <Card title={`Semantic chart matches (${hits.length})`} className="mb-5">
          {hits.length === 0 ? <Empty text="No matches (or agents service not running)." /> : (
            <div className="divide-y divide-line/50">
              {hits.map((h) => (
                <div key={h.noteId} className="px-5 py-3">
                  <div className="mb-1 flex items-center gap-3 text-xs text-ink-faint">
                    <Link href={`/patients/${location!.id}/${h.patientSourceId}`} className="font-medium text-teal hover:underline">
                      {h.patientName ?? `Patient #${h.patientSourceId}`}
                    </Link>
                    <span className="num">note {h.noteId}</span>
                    <span className="num">{(h.similarity * 100).toFixed(0)}% match</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-soft">{h.content.slice(0, 260)}…</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      <Card>
        {rows.length === 0 ? (
          <Empty text="No patients match." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-line/70">
              <tr><Th>Name</Th><Th>Birthdate</Th><Th>Mobile</Th><Th>Email</Th><Th>City</Th><Th>Status</Th></tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {rows.map((p) => (
                <tr key={p.sourceId} className="hover:bg-mint/25">
                  <Td>
                    <Link href={`/patients/${location!.id}/${p.sourceId}`} className="font-medium hover:text-teal">
                      {p.lastName}, {p.firstName}
                    </Link>
                  </Td>
                  <Td className="num">{fmtDate(p.birthdate)}</Td>
                  <Td className="num">{p.wirelessPhone}</Td>
                  <Td className="text-ink-soft">{p.email}</Td>
                  <Td className="text-ink-soft">{p.city}</Td>
                  <Td><Chip value={p.status} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
