"use client";

// Small shared pieces: stat tiles, status chips, section headers, tables.

import { Rise } from "@/components/motion/motion";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { TiltCard } from "@/components/motion/tilt-card";

export function PageTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <Rise className="mb-6">
      <div className="text-[11px] uppercase tracking-[0.24em] text-teal">{kicker}</div>
      <h1 className="font-display mt-1 text-4xl font-medium tracking-tight">{title}</h1>
    </Rise>
  );
}

export function StatTile({
  label, value, detail, tone = "default", format
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: "default" | "alert" | "warn" | "good";
  format?: (v: number) => string;
}) {
  const toneRing = {
    default: "border-line",
    alert: "border-coral/50",
    warn: "border-amber/50",
    good: "border-teal/40"
  }[tone];
  const toneText = {
    default: "text-ink",
    alert: "text-coral",
    warn: "text-amber",
    good: "text-teal"
  }[tone];
  const toneBar = {
    default: "from-pine-2/40 to-sage/30",
    alert: "from-coral to-coral/30",
    warn: "from-amber to-amber/30",
    good: "from-teal to-teal/30"
  }[tone];
  return (
    <div
      className={`group relative overflow-hidden rounded-lg border ${toneRing} bg-surface px-5 py-4 shadow-[var(--shadow-xs)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]`}
    >
      <div
        aria-hidden
        className={`absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${toneBar} opacity-70 transition-opacity group-hover:opacity-100`}
      />
      <div className="text-[11px] uppercase tracking-[0.18em] text-ink-faint">{label}</div>
      <div className={`num mt-2 text-3xl font-medium ${toneText}`}>
        {typeof value === "number" ? <AnimatedNumber value={value} format={format} /> : value}
      </div>
      {detail && <div className="mt-1 text-xs text-ink-soft">{detail}</div>}
    </div>
  );
}

const CHIP_STYLES: Record<string, string> = {
  scheduled: "bg-mint text-pine",
  complete: "bg-line/70 text-ink-soft",
  broken: "bg-coral-soft text-coral",
  unscheduled: "bg-amber-soft text-amber",
  planned: "bg-surface text-ink-faint border border-line",
  pending: "bg-amber-soft text-amber",
  approved: "bg-mint text-pine",
  executed: "bg-mint text-pine",
  rejected: "bg-coral-soft text-coral",
  applied: "bg-mint text-pine",
  failed: "bg-coral-soft text-coral",
  sent: "bg-amber-soft text-amber",
  received: "bg-mint text-pine",
  active: "bg-mint text-pine",
  inactive: "bg-line/70 text-ink-soft"
};

export function Chip({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${CHIP_STYLES[value] ?? "bg-line/70 text-ink-soft"}`}>
      {value}
    </span>
  );
}

export function Card({ title, action, children, className = "", interactive = false }: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  const card = (
    <section
      className={`rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-sm)] transition-shadow duration-300 hover:shadow-[var(--shadow-md)] ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-line/70 px-5 py-3">
          {title && <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-soft">{title}</h2>}
          {action}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
  return interactive ? <TiltCard className="rounded-[var(--radius-card)]">{card}</TiltCard> : card;
}

export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-5 py-2.5 text-[13.5px] ${className}`}>{children}</td>;
}

export function Empty({ text, icon, action }: {
  text: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-10 text-center text-sm text-ink-faint">
      {icon && <div className="mb-3 flex justify-center text-2xl text-ink-faint/70">{icon}</div>}
      {text}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function fmtTime(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function fmtDate(iso: string | Date | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
export function fmtMoney(n: number): string {
  return n.toLocaleString([], { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
