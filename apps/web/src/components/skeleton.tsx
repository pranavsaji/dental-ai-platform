"use client";

// Shimmer loading placeholders. The shimmer keyframe lives in globals.css
// and is disabled under prefers-reduced-motion (static block instead).

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton rounded-md ${className}`} />;
}

export function StatTileSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-surface px-5 py-4 shadow-[var(--shadow-xs)]">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  );
}

export function StatTileSkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <StatTileSkeleton key={i} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="px-5 py-4">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 py-2.5">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? "w-40" : "w-24"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-xs)]">
      <Skeleton className="h-3 w-32" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`mt-3 h-4 ${i % 2 ? "w-3/4" : "w-full"}`} />
      ))}
    </div>
  );
}
