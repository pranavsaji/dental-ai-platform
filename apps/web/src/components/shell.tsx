"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, clearSession, getToken, getUser, type Location, type SessionUser } from "@/lib/api";

interface AppCtx {
  user: SessionUser;
  locations: Location[];
  location: Location | null;
  setLocationId: (id: number) => void;
}

const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside shell");
  return v;
};

const NAV = [
  { href: "/", label: "Overview", glyph: "◳" },
  { href: "/schedule", label: "Schedule", glyph: "▤" },
  { href: "/patients", label: "Patients", glyph: "◍" },
  { href: "/billing", label: "Billing", glyph: "◈" },
  { href: "/approvals", label: "Approvals", glyph: "✳" },
  { href: "/tasks", label: "Tasks", glyph: "☰" },
  { href: "/sms", label: "SMS Console", glyph: "◗" },
  { href: "/audit", label: "Audit Trail", glyph: "≡" }
];

// Integration provenance badge (A1): keeps the header honest about whether
// this location's data is a live PMS, the API, or the embedded mock.
function IntegrationBadge({ location }: { location: Location }) {
  const mode = location.integrationMode ?? "unknown";
  const status = location.integrationStatus ?? "unknown";
  const beat = location.lastHeartbeatAt ? new Date(location.lastHeartbeatAt).getTime() : 0;
  const stale = beat > 0 && Date.now() - beat > 60_000;
  const label =
    mode === "unknown" || beat === 0 ? "edge offline" :
    stale ? `${mode} · stale` :
    status === "degraded" ? `mock · degraded from ${mode === "mock" ? "pms" : mode}` :
    `live via ${mode}`;
  const tone =
    mode === "unknown" || beat === 0 || stale ? "bg-line/70 text-ink-soft" :
    status === "degraded" ? "bg-amber-soft text-amber" :
    mode === "mock" ? "bg-amber-soft text-amber" :
    "bg-mint text-pine";
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${tone}`} title={`PMS integration: ${mode} (${status})`}>
      {label}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationIdState] = useState<number | null>(null);
  const [openTasks, setOpenTasks] = useState<number>(0);
  const isLogin = pathname === "/login";

  useEffect(() => {
    if (isLogin) return;
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setUser(getUser());
    const loadLocations = (first: boolean) =>
      api<Location[]>("/portal/locations").then((locs) => {
        setLocations(locs);
        if (first) {
          const stored = Number(window.localStorage.getItem("dental.locationId"));
          const initial = locs.find((l) => l.id === stored) ?? locs[0];
          if (initial) setLocationIdState(initial.id);
        }
      }).catch(() => {});
    loadLocations(true);
    // Refresh periodically so the integration badge tracks edge heartbeats.
    const t = setInterval(() => loadLocations(false), 15_000);
    return () => clearInterval(t);
  }, [isLogin, router]);

  // Open-task count for the sidebar badge (A5); SSE replaces polling in F1.
  useEffect(() => {
    if (isLogin || locationId == null) return;
    const load = () =>
      api<{ open: number; inProgress: number; urgent: number }>(`/portal/tasks/summary?locationId=${locationId}`)
        .then((s) => setOpenTasks(s.open + s.inProgress))
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [isLogin, locationId]);

  const ctx = useMemo<AppCtx | null>(() => {
    if (!user) return null;
    return {
      user,
      locations,
      location: locations.find((l) => l.id === locationId) ?? null,
      setLocationId: (id: number) => {
        window.localStorage.setItem("dental.locationId", String(id));
        setLocationIdState(id);
      }
    };
  }, [user, locations, locationId]);

  if (isLogin) return <>{children}</>;
  if (!ctx || !ctx.location) {
    return (
      <div className="grid min-h-screen place-items-center text-ink-soft">
        <div className="text-sm tracking-widest uppercase animate-pulse">Loading…</div>
      </div>
    );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="grain flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 flex w-56 flex-col bg-pine text-mint">
          <div className="px-6 pb-8 pt-7">
            <div className="font-display text-3xl font-semibold tracking-tight text-white">Dental AI</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-sage">
              Dental Operating System
            </div>
          </div>
          <nav className="flex-1 space-y-0.5 px-3">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-[13.5px] transition-colors ${
                    active
                      ? "bg-pine-2 text-white shadow-[inset_2px_0_0_0_theme(colors.mint-deep)]"
                      : "text-mint/75 hover:bg-pine-2/60 hover:text-white"
                  }`}
                >
                  <span className="w-4 text-center opacity-80">{n.glyph}</span>
                  <span className="flex-1">{n.label}</span>
                  {n.href === "/tasks" && openTasks > 0 && (
                    <span className="num rounded-full bg-mint-deep/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-pine">
                      {openTasks}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-pine-2 px-6 py-4 text-xs">
            <div className="text-white">{ctx.user.name}</div>
            <div className="mt-0.5 text-mint/60">{ctx.user.role}</div>
            <button
              className="mt-3 text-mint/80 underline-offset-2 hover:text-white hover:underline"
              onClick={() => { clearSession(); router.replace("/login"); }}
            >
              Sign out
            </button>
          </div>
        </aside>

        <div className="ml-56 flex-1">
          <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-paper/90 px-8 py-3 backdrop-blur">
            <div className="text-[11px] uppercase tracking-[0.2em] text-ink-faint">
              Lone Star Dental Group
            </div>
            <div className="flex items-center gap-3">
              <IntegrationBadge location={ctx.location} />
              <span className="text-[11px] uppercase tracking-widest text-ink-faint">Location</span>
              <select
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm shadow-sm outline-none focus:border-teal"
                value={ctx.location.id}
                onChange={(e) => ctx.setLocationId(Number(e.target.value))}
                disabled={ctx.user.locationId != null}
              >
                {ctx.locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          </header>
          <main className="px-8 py-7">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
