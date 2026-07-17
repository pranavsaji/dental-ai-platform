"use client";

// Animated multi-series area chart — the upgrade of the old one-line SVG
// sparkline. Gradient fill per series (driven by the same text-* tone
// classes via currentColor), draw-on line animation, hover crosshair with
// a glass tooltip. Point strings are memoized; reduced motion renders the
// final state instantly.

import { useId, useMemo, useRef, useState } from "react";
import { m } from "motion/react";
import { usePrefersReducedMotion } from "@/lib/capabilities";
import { ChartTooltip } from "./chart-tooltip";

export interface AreaSeries {
  tone: string; // text-* class, e.g. "text-teal"
  name: string;
  values: number[];
}

const W = 220;

export function AreaChart({
  series,
  labels = [],
  height = 56,
  format = (v) => String(Math.round(v))
}: {
  series: AreaSeries[];
  labels?: string[];
  height?: number;
  format?: (v: number) => string;
}) {
  const gradId = useId().replace(/[:]/g, "");
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { paths, min, max, maxLen } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    const mn = all.length ? Math.min(...all) : 0;
    const mx = all.length ? Math.max(...all) : 0;
    const span = mx - mn || 1;
    const longest = Math.max(0, ...series.map((s) => s.values.length));
    const built = series.map((s) => {
      if (s.values.length < 2) return null;
      const pts = s.values.map((v, i) => {
        const x = (i / (s.values.length - 1)) * (W - 4) + 2;
        const y = height - 5 - ((v - mn) / span) * (height - 12);
        return [x, y] as const;
      });
      const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - 2} L${pts[0][0].toFixed(1)},${height - 2} Z`;
      return { line, area };
    });
    return { paths: built, min: mn, max: mx, maxLen: longest };
  }, [series, height]);

  if (paths.every((p) => p === null)) return <div style={{ height }} />;

  function onMove(e: React.PointerEvent) {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || maxLen < 2) return;
    const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    setHoverIdx(Math.round(frac * (maxLen - 1)));
  }

  const hoverFrac = hoverIdx != null && maxLen > 1 ? hoverIdx / (maxLen - 1) : 0;

  return (
    <div
      ref={wrapRef}
      className="relative"
      onPointerMove={onMove}
      onPointerLeave={() => setHoverIdx(null)}
    >
      {/* min/max labels */}
      <div className="num pointer-events-none absolute -top-0.5 right-0 text-[9px] leading-none text-ink-faint">
        {format(max)}
      </div>
      <div className="num pointer-events-none absolute -bottom-0.5 right-0 text-[9px] leading-none text-ink-faint">
        {format(min)}
      </div>

      <svg viewBox={`0 0 ${W} ${height}`} style={{ height }} className="w-full" preserveAspectRatio="none">
        <defs>
          {series.map((s, si) => (
            // tone class on the gradient itself so currentColor resolves to
            // the series color (defs don't inherit from the tone-classed <g>)
            <linearGradient key={si} id={`${gradId}-${si}`} x1="0" y1="0" x2="0" y2="1" className={s.tone}>
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {/* faint top/bottom gridlines */}
        <line x1="2" y1="7" x2={W - 2} y2="7" stroke="currentColor" strokeWidth="0.4" className="text-line" />
        <line x1="2" y1={height - 5} x2={W - 2} y2={height - 5} stroke="currentColor" strokeWidth="0.4" className="text-line" />

        {series.map((s, si) => {
          const p = paths[si];
          if (!p) return null;
          return (
            <g key={si} className={s.tone}>
              <m.path
                d={p.area}
                fill={`url(#${gradId}-${si})`}
                stroke="none"
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.3 }}
              />
              <m.path
                d={p.line}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                initial={reduced ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
                opacity={0.9}
              />
            </g>
          );
        })}

        {hoverIdx != null && (
          <line
            x1={hoverFrac * (W - 4) + 2}
            y1="2"
            x2={hoverFrac * (W - 4) + 2}
            y2={height - 2}
            stroke="currentColor"
            strokeWidth="0.6"
            className="text-ink-faint"
            strokeDasharray="2 2"
          />
        )}
      </svg>

      {hoverIdx != null && (
        <ChartTooltip
          xFrac={hoverFrac}
          title={labels[hoverIdx] ?? `#${hoverIdx + 1}`}
          rows={series
            .filter((s) => s.values.length > 0)
            .map((s) => ({
              tone: s.tone,
              name: s.name,
              value: s.values[hoverIdx] != null ? format(s.values[hoverIdx]) : "—"
            }))}
        />
      )}
    </div>
  );
}
