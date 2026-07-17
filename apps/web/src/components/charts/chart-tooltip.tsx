"use client";

// Shared glass tooltip for the chart kit. Positioned by the parent chart
// as a fraction (0..1) of its width; clamps so it never overflows.

export function ChartTooltip({
  xFrac,
  title,
  rows
}: {
  xFrac: number;
  title: string;
  rows: Array<{ tone: string; name: string; value: string }>;
}) {
  const left = `${Math.min(Math.max(xFrac * 100, 12), 88)}%`;
  return (
    <div
      className="glass pointer-events-none absolute top-0 z-10 w-max -translate-x-1/2 rounded-md border border-line px-3 py-2 shadow-[var(--shadow-md)]"
      style={{ left }}
    >
      <div className="num text-[10px] uppercase tracking-wider text-ink-faint">{title}</div>
      <div className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-2 text-[11px]">
            <span className={`inline-block h-0.5 w-3 bg-current ${r.tone}`} />
            <span className="text-ink-soft">{r.name}</span>
            <span className="num ml-auto pl-3 font-medium text-ink">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
