"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Empty, PageTitle, StatTile, Td, Th, fmtMoney } from "@/components/ui";

// D2: cross-location analytics over the D1 rollup rows. Org-wide surface —
// the API rejects location-pinned or staff users with 403 (rendered as the
// same friendly gate the audit page uses).

interface LocationAgg {
  locationId: number;
  key: string;
  name: string;
  productionCompleted: number;
  productionScheduled: number;
  collections: number;
  collectionRate: number;
  appointmentsCount: number;
  cancellationCount: number;
  noshowCount: number;
  brokenRate: number;
  newPatients: number;
  denialCount: number;
  caseAcceptanceRate: number;
  chairUtilization: number;
  hygieneReappointmentRate: number;
  ar0_30: number;
  ar31_60: number;
  ar61_90: number;
  ar90Plus: number;
  openClaimsValue: number;
  unscheduledTreatmentValue: number;
  latestDate: string | null;
  days: number;
}

interface Summary {
  days: number;
  from: string;
  to: string;
  org: {
    productionCompleted: number;
    collections: number;
    collectionRate: number;
    arTotal: number;
    ar90Plus: number;
    unscheduledTreatmentValue: number;
    newPatients: number;
    openClaimsValue: number;
  };
  locations: LocationAgg[];
}

interface TrendPoint {
  locationId: number;
  date: string;
  productionCompleted: number;
  collections: number;
  brokenRate: number;
  newPatients: number;
  ar90Plus: number;
  chairUtilization: number;
}

interface Trends {
  days: number;
  locations: Array<{ id: number; key: string; name: string }>;
  series: TrendPoint[];
}

interface InsightsAnswer {
  answer: string;
  highlights: string[];
  usedLlm: boolean;
  windowDays: number;
  currentRange: string;
  previousRange: string;
}

const LINE_TONES = ["text-teal", "text-amber", "text-coral", "text-pine"];

function Sparkline({ series, height = 34 }: {
  series: Array<{ tone: string; values: number[] }>;
  height?: number;
}) {
  const all = series.flatMap((s) => s.values);
  if (all.length === 0) return <div className="h-[34px]" />;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const w = 220;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-[34px] w-full" preserveAspectRatio="none">
      {series.map((s, si) => {
        if (s.values.length < 2) return null;
        const pts = s.values
          .map((v, i) => {
            const x = (i / (s.values.length - 1)) * (w - 4) + 2;
            const y = height - 4 - ((v - min) / span) * (height - 8);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return (
          <polyline
            key={si}
            points={pts}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            className={s.tone}
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
}

// Comparison-table metric definitions: how to read the value, how to render
// it, and which direction is bad — the worst cell per column gets flagged.
const COLUMNS: Array<{
  key: string;
  label: string;
  value: (l: LocationAgg) => number;
  render: (l: LocationAgg) => string;
  worst: "high" | "low"; // which end of the range is the bad one
}> = [
  { key: "production", label: "Production", value: (l) => l.productionCompleted, render: (l) => fmtMoney(l.productionCompleted), worst: "low" },
  { key: "collections", label: "Collections", value: (l) => l.collections, render: (l) => fmtMoney(l.collections), worst: "low" },
  { key: "collectRate", label: "Collect %", value: (l) => l.collectionRate, render: (l) => `${Math.round(l.collectionRate * 100)}%`, worst: "low" },
  { key: "brokenRate", label: "Broken rate", value: (l) => l.brokenRate, render: (l) => `${(l.brokenRate * 100).toFixed(1)}%`, worst: "high" },
  { key: "noshows", label: "No-shows", value: (l) => l.noshowCount, render: (l) => String(l.noshowCount), worst: "high" },
  { key: "newPatients", label: "New patients", value: (l) => l.newPatients, render: (l) => String(l.newPatients), worst: "low" },
  { key: "caseAccept", label: "Case accept", value: (l) => l.caseAcceptanceRate, render: (l) => `${Math.round(l.caseAcceptanceRate * 100)}%`, worst: "low" },
  { key: "chairUtil", label: "Chair util", value: (l) => l.chairUtilization, render: (l) => `${Math.round(l.chairUtilization * 100)}%`, worst: "low" },
  { key: "ar90", label: "AR 90+", value: (l) => l.ar90Plus, render: (l) => fmtMoney(l.ar90Plus), worst: "high" },
  { key: "unscheduled", label: "Unscheduled tx", value: (l) => l.unscheduledTreatmentValue, render: (l) => fmtMoney(l.unscheduledTreatmentValue), worst: "high" }
];

const TREND_METRICS: Array<{ key: keyof TrendPoint; label: string; money?: boolean; pct?: boolean }> = [
  { key: "productionCompleted", label: "Production / day", money: true },
  { key: "collections", label: "Collections / day", money: true },
  { key: "brokenRate", label: "Broken rate", pct: true },
  { key: "ar90Plus", label: "AR 90+", money: true },
  { key: "newPatients", label: "New patients" },
  { key: "chairUtilization", label: "Chair utilization", pct: true }
];

export default function AnalyticsPage() {
  const { user, locations } = useApp();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [gate, setGate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [question, setQuestion] = useState("");
  const [windowDays, setWindowDays] = useState(7);
  const [asking, setAsking] = useState(false);
  const [insight, setInsight] = useState<InsightsAnswer | null>(null);

  const load = useCallback(() => {
    api<Summary>(`/portal/analytics/summary?days=${days}`)
      .then((s) => { setSummary(s); setGate(""); })
      .catch((e) => {
        if (e.status === 403) setGate("Analytics requires an org-wide admin or provider account.");
      });
    api<Trends>(`/portal/analytics/trends?days=${days}`).then(setTrends).catch(() => {});
  }, [days]);

  useEffect(() => { load(); }, [load]);

  async function recompute() {
    setBusy("rollup");
    try {
      // One rollup workflow per location; each recomputes the last 7 days
      // from canonical tables (overwriting synthetic bootstrap rows).
      await Promise.all(locations.map((l) =>
        api(`/portal/ops/metrics-rollup?locationId=${l.id}&days=7`, { method: "POST" })));
      setNotice("Metrics rollup started for every location (last 7 days). Numbers refresh as workflows finish.");
      setTimeout(load, 4000);
    } catch (e) {
      setNotice(`Could not start rollup: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function ask() {
    if (!question.trim()) return;
    setAsking(true);
    setInsight(null);
    try {
      const res = await api<InsightsAnswer>("/portal/ops/insights", {
        method: "POST",
        body: JSON.stringify({ question, windowDays })
      });
      setInsight(res);
    } catch (e) {
      setNotice(`Insights failed: ${(e as Error).message}`);
    } finally {
      setAsking(false);
    }
  }

  // Worst cell per column (only meaningful with 2+ locations).
  const worstByColumn = useMemo(() => {
    const map = new Map<string, number>();
    if (!summary || summary.locations.length < 2) return map;
    for (const col of COLUMNS) {
      const vals = summary.locations.map((l) => col.value(l));
      if (new Set(vals).size < 2) continue; // tie — nobody is "worst"
      const worstVal = col.worst === "high" ? Math.max(...vals) : Math.min(...vals);
      const loc = summary.locations.find((l) => col.value(l) === worstVal);
      if (loc) map.set(col.key, loc.locationId);
    }
    return map;
  }, [summary]);

  const trendSeries = useMemo(() => {
    if (!trends) return [];
    return TREND_METRICS.map((m) => ({
      ...m,
      series: trends.locations.map((loc, i) => ({
        tone: LINE_TONES[i % LINE_TONES.length],
        name: loc.name,
        values: trends.series
          .filter((p) => p.locationId === loc.id)
          .map((p) => Number(p[m.key]))
      }))
    }));
  }, [trends]);

  if (gate) {
    return (
      <div>
        <PageTitle kicker="DSO analytics" title="Analytics" />
        <Card><Empty text={gate} /></Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle kicker="DSO analytics" title="Analytics" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Every location side by side, computed nightly from canonical data into
        daily rollups. Worst-in-column is flagged; cells deep-link into the
        underlying worklist.
      </p>

      {notice && (
        <div className="rise mb-4 rounded-md border border-teal/40 bg-mint/40 px-4 py-2.5 text-sm text-pine">
          {notice}
          <button className="ml-3 text-xs underline" onClick={() => setNotice("")}>dismiss</button>
        </div>
      )}

      <div className="rise mb-5 flex items-center gap-2">
        {[30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              days === d ? "bg-pine text-white" : "border border-line text-ink-soft hover:border-teal hover:text-teal"
            }`}
          >
            Last {d} days
          </button>
        ))}
        {/* G4: multi-day backfills overwrite metric history — admin only. */}
        {user.role === "admin" && (
          <button
            disabled={busy === "rollup"}
            onClick={recompute}
            className="ml-auto rounded-md bg-pine px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
          >
            ✳ Recompute rollups (7d)
          </button>
        )}
      </div>

      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label={`Production · ${summary.days}d`} value={fmtMoney(summary.org.productionCompleted)} detail="all locations" />
          <StatTile label="Collections" value={fmtMoney(summary.org.collections)} detail={`${Math.round(summary.org.collectionRate * 100)}% of production`} tone={summary.org.collectionRate < 0.9 ? "warn" : "good"} delay="rise-1" />
          <StatTile label="AR outstanding" value={fmtMoney(summary.org.arTotal)} detail={`${fmtMoney(summary.org.ar90Plus)} at 90+`} tone={summary.org.ar90Plus > 0 ? "warn" : "default"} delay="rise-2" />
          <StatTile label="Unscheduled treatment" value={fmtMoney(summary.org.unscheduledTreatmentValue)} detail={`${summary.org.newPatients} new patients in range`} delay="rise-3" />
        </div>
      )}

      {/* Location comparison (worst-in-column flagged) */}
      <Card title={`Location comparison — ${summary ? `${summary.from} to ${summary.to}` : ""}`} className="rise rise-2 mb-6">
        {!summary || summary.locations.length === 0 ? (
          <Empty text="No metric rows yet. Run the metrics rollup or the bootstrap backfill." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <Th>Location</Th>
                  {COLUMNS.map((c) => <Th key={c.key} className="whitespace-nowrap">{c.label}</Th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {summary.locations.map((l) => (
                  <tr key={l.locationId} className="hover:bg-mint/25">
                    <Td className="whitespace-nowrap font-medium">{l.name}</Td>
                    {COLUMNS.map((c) => {
                      const isWorst = worstByColumn.get(c.key) === l.locationId;
                      const drill =
                        c.key === "ar90" ? `/billing?locationId=${l.locationId}&bucket=${encodeURIComponent("90+")}` :
                        c.key === "unscheduled" || c.key === "collections" ? `/billing?locationId=${l.locationId}` :
                        null;
                      const content = (
                        <span className={`num ${isWorst ? "font-semibold text-coral" : ""}`} title={isWorst ? "Worst across locations" : undefined}>
                          {c.render(l)}{isWorst ? " ▾" : ""}
                        </span>
                      );
                      return (
                        <Td key={c.key} className="whitespace-nowrap">
                          {drill ? <Link href={drill} className="hover:underline">{content}</Link> : content}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Trend sparklines */}
      <Card
        title={`Trends — last ${days} days`}
        className="rise rise-3 mb-6"
        action={
          trends && (
            <div className="flex items-center gap-3 text-[11px] text-ink-soft">
              {trends.locations.map((loc, i) => (
                <span key={loc.id} className="flex items-center gap-1.5">
                  <span className={`inline-block h-0.5 w-4 bg-current ${LINE_TONES[i % LINE_TONES.length]}`} />
                  {loc.name}
                </span>
              ))}
            </div>
          )
        }
      >
        {!trends || trends.series.length === 0 ? (
          <Empty text="No trend data yet." />
        ) : (
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 p-5 md:grid-cols-2 lg:grid-cols-3">
            {trendSeries.map((m) => (
              <div key={String(m.key)}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">{m.label}</span>
                  <span className="num text-[11px] text-ink-soft">
                    {m.series.map((s) => {
                      const last = s.values[s.values.length - 1];
                      if (last == null) return "—";
                      return m.money ? fmtMoney(last) : m.pct ? `${Math.round(last * 100)}%` : String(last);
                    }).join(" · ")}
                  </span>
                </div>
                <Sparkline series={m.series} />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* D3: owner insights */}
      <Card title="Ask about performance" className="rise rise-3">
        <div className="p-5">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal"
              placeholder='e.g. "Why did Round Rock underperform this week?"'
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
            />
            <select
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-teal"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            >
              <option value={7}>7d vs prior 7d</option>
              <option value={14}>14d vs prior 14d</option>
              <option value={30}>30d vs prior 30d</option>
            </select>
            <button
              disabled={asking || !question.trim()}
              onClick={ask}
              className="rounded-md bg-pine px-4 py-2 text-xs font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
            >
              {asking ? "Comparing…" : "Ask"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            Answers are grounded in metric deltas only ({"current window vs the one before"}) —
            the agent cites metric names and values, and “not in the data” is a valid answer.
          </p>
          {insight && (
            <div className="mt-4 rounded-md border border-line bg-paper px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-faint">
                <span className={`rounded-full px-2 py-0.5 font-medium ${insight.usedLlm ? "bg-mint text-pine" : "bg-line/70 text-ink-soft"}`}>
                  {insight.usedLlm ? "LLM narrative" : "deterministic z-score template"}
                </span>
                <span className="num">{insight.currentRange} vs {insight.previousRange}</span>
              </div>
              <p className="text-sm leading-relaxed">{insight.answer}</p>
              {insight.highlights.length > 0 && (
                <ul className="mt-2 space-y-1 border-t border-line/60 pt-2">
                  {insight.highlights.map((h, i) => (
                    <li key={i} className="num text-xs text-ink-soft">▸ {h}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
