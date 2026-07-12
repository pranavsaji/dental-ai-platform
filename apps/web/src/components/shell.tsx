"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { API_URL, api, clearSession, getUser, setSession, type Location, type SessionUser } from "@/lib/api";

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
  { href: "/analytics", label: "Analytics", glyph: "∿" },
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

interface Notification {
  id: number;
  type: string;
  title: string;
  body: string;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
}

// F1: deep link per event type — clicking a notification lands on the page
// where the work is.
function notificationHref(n: Notification): string {
  switch (n.type) {
    case "approval.created": return "/approvals";
    case "task.created": return "/tasks";
    case "sms.received": return "/sms";
    case "huddle.ready": return "/";
    case "sync.lagging": return "/";
    default: return "/";
  }
}

const TYPE_GLYPH: Record<string, string> = {
  "approval.created": "✳",
  "task.created": "☰",
  "sms.received": "◗",
  "huddle.ready": "◳",
  "sync.lagging": "⚠"
};

// F1: notification bell. Live events arrive over SSE (the session cookie
// authenticates the EventSource — the F2 cookie work is what makes this
// guardable); the backlog loads from /portal/notifications. Unread state is a
// per-location last-seen watermark in localStorage.
function NotificationBell({ locationId, onEvent }: {
  locationId: number;
  onEvent: (type: string) => void;
}) {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState<number>(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const seenKey = `dental.notifSeen.${locationId}`;

  useEffect(() => {
    setSeenAt(Number(window.localStorage.getItem(seenKey) ?? 0));
    api<Notification[]>(`/portal/notifications?locationId=${locationId}`)
      .then(setItems)
      .catch(() => {});
  }, [locationId, seenKey]);

  // Live stream; the browser reconnects dropped EventSources on its own, and
  // the pages' interval pollers remain as the fallback when the stream is down.
  useEffect(() => {
    const es = new EventSource(`${API_URL}/portal/events?locationId=${locationId}`, {
      withCredentials: true
    });
    const handler = (e: MessageEvent) => {
      try {
        const evt = JSON.parse(e.data) as Notification;
        setItems((prev) => [evt, ...prev.filter((p) => p.id !== evt.id)].slice(0, 50));
        onEvent(evt.type);
      } catch {
        /* malformed event — ignore */
      }
    };
    es.addEventListener("notification", handler);
    return () => es.close();
  }, [locationId, onEvent]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const unread = items.filter((n) => new Date(n.createdAt).getTime() > seenAt).length;

  function markAllRead() {
    const now = Date.now();
    window.localStorage.setItem(seenKey, String(now));
    setSeenAt(now);
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        className="relative rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm shadow-sm transition hover:border-teal"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
      >
        ◔
        {unread > 0 && (
          <span className="num absolute -right-1.5 -top-1.5 rounded-full bg-coral px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-96 rounded-lg border border-line bg-paper shadow-xl">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
              Notifications
            </span>
            <button className="text-xs text-teal underline-offset-2 hover:underline" onClick={markAllRead}>
              Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-ink-faint">Nothing yet.</div>
            )}
            {items.map((n) => {
              const isUnread = new Date(n.createdAt).getTime() > seenAt;
              return (
                <Link
                  key={n.id}
                  href={notificationHref(n)}
                  onClick={() => setOpen(false)}
                  className={`block border-b border-line/50 px-4 py-3 transition hover:bg-surface ${isUnread ? "bg-mint/20" : ""}`}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 w-4 text-center text-ink-faint">{TYPE_GLYPH[n.type] ?? "•"}</span>
                    <div className="min-w-0 flex-1">
                      <div className={`text-[13px] leading-snug ${isUnread ? "font-medium text-ink" : "text-ink-soft"}`}>
                        {n.title}
                      </div>
                      {n.body && <div className="mt-0.5 truncate text-xs text-ink-faint">{n.body}</div>}
                      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                        {new Date(n.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationIdState] = useState<number | null>(null);
  const [openTasks, setOpenTasks] = useState<number>(0);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const isLogin = pathname === "/login" || pathname.startsWith("/login/");

  useEffect(() => {
    if (isLogin) return;
    // F2: authorization lives in the httpOnly cookie; the stored profile is
    // just a render hint. Confirm the cookie is live (and refresh the profile).
    const cached = getUser();
    if (cached) setUser(cached);
    api<SessionUser>("/auth/me")
      .then((me) => { setSession(me); setUser(me); })
      .catch(() => router.replace("/login"));

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

  // Open-task count for the sidebar badge (A5). Polling stays as the fallback;
  // F1's SSE events bump taskRefresh so the badge reacts instantly.
  useEffect(() => {
    if (isLogin || locationId == null) return;
    const load = () =>
      api<{ open: number; inProgress: number; urgent: number }>(`/portal/tasks/summary?locationId=${locationId}`)
        .then((s) => setOpenTasks(s.open + s.inProgress))
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [isLogin, locationId, taskRefresh]);

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

  const nav = ctx.user.role === "admin"
    ? [
        ...NAV,
        { href: "/admin/users", label: "Users", glyph: "⛭" },
        { href: "/admin/locations", label: "Locations", glyph: "⌖" }
      ]
    : NAV;

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
            {nav.map((n) => {
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
            <div className="mt-3 flex items-center gap-3">
              <Link href="/account" className="text-mint/80 underline-offset-2 hover:text-white hover:underline">
                Account
              </Link>
              <button
                className="text-mint/80 underline-offset-2 hover:text-white hover:underline"
                onClick={() => { clearSession(); router.replace("/login"); }}
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        {/* min-w-0: let wide tables scroll inside overflow-x-auto instead of
            stretching the flex item (and the whole page) past the viewport. */}
        <div className="ml-56 min-w-0 flex-1">
          <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-paper/90 px-8 py-3 backdrop-blur">
            <div className="text-[11px] uppercase tracking-[0.2em] text-ink-faint">
              Lone Star Dental Group
            </div>
            <div className="flex items-center gap-3">
              <NotificationBell
                locationId={ctx.location.id}
                onEvent={(type) => {
                  if (type === "task.created") setTaskRefresh((k) => k + 1);
                }}
              />
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
