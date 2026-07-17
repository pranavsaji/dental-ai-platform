"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, Empty, PageTitle, StatTile, fmtMoney } from "@/components/ui";
import { RequireRole } from "@/components/require-role";
import { AreaChart } from "@/components/charts/area-chart";
import { m, AnimatePresence, StaggerList, StaggerItem } from "@/components/motion/motion";
import { fadeSwap } from "@/components/motion/presets";
import { StatTileSkeleton, TableSkeleton } from "@/components/skeleton";
import { usePrefersReducedMotion } from "@/lib/capabilities";

// Org dashboard: every clinic in the organization as an interactive card —
// revenue, trend sparkline, health flags — with a per-clinic drill-down
// (metric-switchable trend vs the org average, AR aging, deep links).
// Reads the same D2 endpoints as /analytics; that page stays the dense
// comparison table, this one is the owner's at-a-glance surface.

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

type TrendKey = "collections" | "productionCompleted" | "brokenRate" | "newPatients" | "ar90Plus" | "chairUtilization";

const TREND_METRICS: Array<{ key: TrendKey; label: string; money?: boolean; pct?: boolean }> = [
  { key: "collections", label: "Collections / day", money: true },
  { key: "productionCompleted", label: "Production / day", money: true },
  { key: "brokenRate", label: "Broken rate", pct: true },
  { key: "newPatients", label: "New patients" },
  { key: "ar90Plus", label: "AR 90+", money: true },
  { key: "chairUtilization", label: "Chair utilization", pct: true }
];

const SORTS: Array<{ key: string; label: string; value: (l: LocationAgg) => number; desc: boolean }> = [
  { key: "collections", label: "Revenue", value: (l) => l.collections, desc: true },
  { key: "production", label: "Production", value: (l) => l.productionCompleted, desc: true },
  { key: "ar90", label: "AR 90+", value: (l) => l.ar90Plus, desc: true },
  { key: "broken", label: "Broken rate", value: (l) => l.brokenRate, desc: true }
];

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtPct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

// AR aging: one measure across ordinal buckets → single hue; the 90+ bucket
// wears the app's established alert color (labeled, never color-alone).
function ArAgingBars({ loc }: { loc: LocationAgg }) {
  const reduced = usePrefersReducedMotion();
  const buckets = [
    { label: "0–30 days", value: loc.ar0_30, alert: false },
    { label: "31–60 days", value: loc.ar31_60, alert: false },
    { label: "61–90 days", value: loc.ar61_90, alert: false },
    { label: "90+ days", value: loc.ar90Plus, alert: true }
  ];
  const max = Math.max(...buckets.map((b) => b.value), 1);
  return (
    <div className="space-y-2.5">
      {buckets.map((b, i) => (
        <div key={b.label} className="flex items-center gap-3">
          <div className="w-24 shrink-0 text-right text-xs text-ink-soft">{b.label}</div>
          <div className="h-4 flex-1 overflow-hidden rounded-sm bg-line/40">
            <m.div
              className={`h-full rounded-sm ${b.alert ? "bg-coral/80" : "bg-chart-teal/75"}`}
              initial={reduced ? false : { width: 0 }}
              animate={{ width: `${(b.value / max) * 100}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 24, delay: i * 0.07 }}
            />
          </div>
          <div className={`num w-24 shrink-0 text-xs ${b.alert && b.value > 0 ? "font-semibold text-coral" : "text-ink"}`}>
            {fmtMoney(b.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClinicCard({ loc, spark, selected, onSelect }: {
  loc: LocationAgg;
  spark: { labels: string[]; values: number[] };
  selected: boolean;
  onSelect: () => void;
}) {
  const flags: Array<{ text: string; tone: string }> = [];
  if (loc.collectionRate < 0.9 && loc.productionCompleted > 0)
    flags.push({ text: `${fmtPct(loc.collectionRate)} collected`, tone: "bg-amber-soft text-amber" });
  if (loc.ar90Plus > 0) flags.push({ text: `${fmtMoney(loc.ar90Plus)} at 90+`, tone: "bg-coral-soft text-coral" });
  if (loc.brokenRate >= 0.1) flags.push({ text: `${fmtPct1(loc.brokenRate)} broken`, tone: "bg-coral-soft text-coral" });
  if (flags.length === 0) flags.push({ text: "healthy", tone: "bg-mint text-pine" });

  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative overflow-hidden rounded-lg border bg-surface px-5 py-4 text-left shadow-[var(--shadow-xs)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] ${
        selected ? "border-teal shadow-[var(--shadow-sm)] ring-1 ring-teal/40" : "border-line"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold text-ink">{loc.name}</div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{loc.key}</div>
        </div>
        <span className={`shrink-0 text-[11px] font-medium ${selected ? "text-teal" : "text-ink-faint group-hover:text-teal"}`}>
          {selected ? "viewing" : "view →"}
        </span>
      </div>
      <div className="num mt-3 text-2xl font-medium text-ink">{fmtMoney(loc.collections)}</div>
      <div className="mt-0.5 text-xs text-ink-soft">
        collected · {fmtMoney(loc.productionCompleted)} produced
      </div>
      <div className="mt-3 text-chart-teal">
        <AreaChart
          series={[{ tone: "text-chart-teal", name: "Collections", values: spark.values }]}
          labels={spark.labels}
          height={44}
          format={fmtMoney}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {flags.map((f) => (
          <span key={f.text} className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${f.tone}`}>
            {f.text}
          </span>
        ))}
        <span className="ml-auto rounded-full bg-line/50 px-2 py-0.5 text-[10.5px] text-ink-soft">
          {loc.newPatients} new pts
        </span>
      </div>
    </button>
  );
}

function OrgDashboardPage() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [gate, setGate] = useState("");
  const [sortKey, setSortKey] = useState("collections");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [metricKey, setMetricKey] = useState<TrendKey>("collections");

  const load = useCallback(() => {
    api<Summary>(`/portal/analytics/summary?days=${days}`)
      .then((s) => { setSummary(s); setGate(""); })
      .catch((e) => {
        if (e.status === 403) setGate("The org dashboard requires an org-wide admin account (not pinned to one location).");
      });
    api<Trends>(`/portal/analytics/trends?days=${days}`).then(setTrends).catch(() => {});
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    if (!summary) return [];
    const s = SORTS.find((x) => x.key === sortKey) ?? SORTS[0];
    return [...summary.locations].sort((a, b) => (s.desc ? s.value(b) - s.value(a) : s.value(a) - s.value(b)));
  }, [summary, sortKey]);

  // Default drill-down: the top clinic under the current sort. Selection
  // sticks across re-sorts and range changes as long as the clinic exists.
  const selected = useMemo(() => {
    if (sorted.length === 0) return null;
    return sorted.find((l) => l.locationId === selectedId) ?? sorted[0];
  }, [sorted, selectedId]);

  // Per-clinic daily series keyed by locationId, plus the per-date org
  // average (per clinic) so the drill-down has a comparable reference line.
  const daily = useMemo(() => {
    const byLoc = new Map<number, TrendPoint[]>();
    const byDate = new Map<string, TrendPoint[]>();
    for (const p of trends?.series ?? []) {
      byLoc.set(p.locationId, [...(byLoc.get(p.locationId) ?? []), p]);
      byDate.set(p.date, [...(byDate.get(p.date) ?? []), p]);
    }
    return { byLoc, byDate };
  }, [trends]);

  const sparkFor = useCallback((locationId: number) => {
    const rows = daily.byLoc.get(locationId) ?? [];
    return { labels: rows.map((r) => r.date), values: rows.map((r) => r.collections) };
  }, [daily]);

  const metric = TREND_METRICS.find((mt) => mt.key === metricKey) ?? TREND_METRICS[0];
  const detailChart = useMemo(() => {
    if (!selected) return null;
    const rows = daily.byLoc.get(selected.locationId) ?? [];
    const labels = rows.map((r) => r.date);
    const clinic = rows.map((r) => Number(r[metric.key]));
    const orgAvg = rows.map((r) => {
      const day = daily.byDate.get(r.date) ?? [];
      return day.length > 0 ? day.reduce((s, p) => s + Number(p[metric.key]), 0) / day.length : 0;
    });
    return { labels, clinic, orgAvg };
  }, [selected, daily, metric.key]);

  const fmtMetric = (v: number) =>
    metric.money ? fmtMoney(v) : metric.pct ? fmtPct(v) : String(Math.round(v));

  if (gate) {
    return (
      <div>
        <PageTitle kicker="All clinics" title="Org Dashboard" />
        <Card><Empty text={gate} /></Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle kicker="All clinics" title="Org Dashboard" />
      <p className="-mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Every clinic in the organization at a glance — revenue, trend, and health
        flags. Select a clinic to drill into its performance against the org average.
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
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
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
          Sort clinics by
          <select
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-teal"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
          >
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {/* Org rollup */}
      {!summary ? (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <StatTileSkeleton key={i} />)}
        </div>
      ) : (
        <StaggerList className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StaggerItem>
            <StatTile label={`Revenue · ${summary.days}d`} value={summary.org.collections} format={fmtMoney}
              detail={`${fmtPct(summary.org.collectionRate)} of production collected`}
              tone={summary.org.collectionRate < 0.9 ? "warn" : "good"} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="Production" value={summary.org.productionCompleted} format={fmtMoney}
              detail={`across ${summary.locations.length} clinics`} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="AR outstanding" value={summary.org.arTotal} format={fmtMoney}
              detail={`${fmtMoney(summary.org.ar90Plus)} at 90+`}
              tone={summary.org.ar90Plus > 0 ? "warn" : "default"} />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="New patients" value={summary.org.newPatients}
              detail={`${fmtMoney(summary.org.unscheduledTreatmentValue)} unscheduled treatment`} />
          </StaggerItem>
        </StaggerList>
      )}

      {/* Clinic cards */}
      {!summary ? (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => <StatTileSkeleton key={i} />)}
        </div>
      ) : sorted.length === 0 ? (
        <Card className="mb-6">
          <Empty text="No metric rows yet. Run the metrics rollup from the Analytics page." />
        </Card>
      ) : (
        <StaggerList className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((loc) => (
            <StaggerItem key={loc.locationId}>
              <ClinicCard
                loc={loc}
                spark={sparkFor(loc.locationId)}
                selected={selected?.locationId === loc.locationId}
                onSelect={() => setSelectedId(loc.locationId)}
              />
            </StaggerItem>
          ))}
        </StaggerList>
      )}

      {/* Drill-down */}
      {selected && (
        <AnimatePresence mode="wait" initial={false}>
          <m.div key={`${selected.locationId}-${days}`} variants={fadeSwap} initial="hidden" animate="show" exit="exit">
            <Card
              title={`${selected.name} — ${summary ? `${summary.from} to ${summary.to}` : ""}`}
              className="mb-6"
              action={
                <div className="flex items-center gap-3 text-xs">
                  <Link href={`/billing?locationId=${selected.locationId}`} className="font-medium text-teal hover:underline">
                    Billing →
                  </Link>
                  <Link href="/analytics" className="font-medium text-teal hover:underline">
                    Full comparison →
                  </Link>
                </div>
              }
            >
              <div className="grid grid-cols-2 gap-4 border-b border-line/60 p-5 md:grid-cols-3 xl:grid-cols-6">
                <StatTile label="Revenue" value={selected.collections} format={fmtMoney}
                  detail={`${fmtPct(selected.collectionRate)} of production`}
                  tone={selected.collectionRate < 0.9 && selected.productionCompleted > 0 ? "warn" : "good"} />
                <StatTile label="Production" value={selected.productionCompleted} format={fmtMoney}
                  detail={`${fmtMoney(selected.productionScheduled)} scheduled`} />
                <StatTile label="Broken rate" value={fmtPct1(selected.brokenRate)}
                  detail={`${selected.cancellationCount} cancels · ${selected.noshowCount} no-shows`}
                  tone={selected.brokenRate >= 0.1 ? "alert" : "default"} />
                <StatTile label="New patients" value={selected.newPatients} detail={`over ${selected.days} days`} />
                <StatTile label="Chair utilization" value={fmtPct(selected.chairUtilization)}
                  detail={`case accept ${fmtPct(selected.caseAcceptanceRate)}`} />
                <StatTile label="Open claims" value={selected.openClaimsValue} format={fmtMoney}
                  detail={`${selected.denialCount} denials in range`}
                  tone={selected.openClaimsValue > 0 ? "warn" : "default"} />
              </div>

              <div className="grid grid-cols-1 gap-x-8 gap-y-6 p-5 lg:grid-cols-5">
                {/* Trend vs org average */}
                <div className="lg:col-span-3">
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    {TREND_METRICS.map((mt) => (
                      <button
                        key={mt.key}
                        onClick={() => setMetricKey(mt.key)}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${
                          metricKey === mt.key
                            ? "bg-pine text-white"
                            : "border border-line text-ink-soft hover:border-teal hover:text-teal"
                        }`}
                      >
                        {mt.label}
                      </button>
                    ))}
                  </div>
                  {!trends ? (
                    <TableSkeleton rows={3} cols={3} />
                  ) : !detailChart || detailChart.labels.length < 2 ? (
                    <Empty text="No daily series for this clinic yet." />
                  ) : (
                    <>
                      <div className="mb-1.5 flex items-center gap-4 text-[11px] text-ink-soft">
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block h-0.5 w-4 bg-current text-chart-teal" />
                          {selected.name}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block h-0.5 w-4 bg-current text-amber" />
                          Org avg / clinic
                        </span>
                      </div>
                      <AreaChart
                        series={[
                          { tone: "text-chart-teal", name: selected.name, values: detailChart.clinic },
                          { tone: "text-amber", name: "Org avg / clinic", values: detailChart.orgAvg }
                        ]}
                        labels={detailChart.labels}
                        height={130}
                        format={fmtMetric}
                      />
                    </>
                  )}
                </div>

                {/* AR aging */}
                <div className="lg:col-span-2">
                  <div className="mb-3 flex items-baseline justify-between">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">AR aging</span>
                    <span className="num text-xs text-ink-soft">
                      {fmtMoney(selected.ar0_30 + selected.ar31_60 + selected.ar61_90 + selected.ar90Plus)} total
                    </span>
                  </div>
                  <ArAgingBars loc={selected} />
                  {selected.ar90Plus > 0 && (
                    <Link
                      href={`/billing?locationId=${selected.locationId}&bucket=${encodeURIComponent("90+")}`}
                      className="mt-3 inline-block text-xs font-medium text-teal hover:underline"
                    >
                      Work the 90+ bucket →
                    </Link>
                  )}
                  <div className="mt-4 border-t border-line/60 pt-3 text-xs text-ink-soft">
                    <span className="num font-medium text-ink">{fmtMoney(selected.unscheduledTreatmentValue)}</span>{" "}
                    in unscheduled treatment · as of {selected.latestDate ?? "—"}
                  </div>
                </div>
              </div>
            </Card>
          </m.div>
        </AnimatePresence>
      )}
    </div>
  );
}

export default function OrgDashboardGuarded() {
  return (
    <RequireRole roles={["admin"]} kicker="All clinics" title="Org Dashboard">
      <OrgDashboardPage />
    </RequireRole>
  );
}
