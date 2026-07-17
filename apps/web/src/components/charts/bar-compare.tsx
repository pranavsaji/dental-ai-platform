"use client";

// Animated horizontal comparison bars — spring from zero, staggered. The
// worst performer is tinted coral, matching the table's worst-in-column
// flagging.

import { m } from "motion/react";
import { usePrefersReducedMotion } from "@/lib/capabilities";

export function BarCompare({
  items,
  format = (v) => String(Math.round(v)),
  worstId
}: {
  items: Array<{ id: number; label: string; value: number }>;
  format?: (v: number) => string;
  worstId?: number | null;
}) {
  const reduced = usePrefersReducedMotion();
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2.5">
      {items.map((item, i) => {
        const isWorst = worstId != null && item.id === worstId;
        return (
          <div key={item.id} className="flex items-center gap-3">
            <div className="w-28 shrink-0 truncate text-right text-xs text-ink-soft">{item.label}</div>
            <div className="h-4 flex-1 overflow-hidden rounded-sm bg-line/40">
              <m.div
                className={`h-full rounded-sm ${isWorst ? "bg-coral/80" : "bg-teal/80"}`}
                initial={reduced ? false : { width: 0 }}
                animate={{ width: `${(item.value / max) * 100}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 24, delay: i * 0.07 }}
              />
            </div>
            <div className={`num w-24 shrink-0 text-xs ${isWorst ? "font-semibold text-coral" : "text-ink"}`}>
              {format(item.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
