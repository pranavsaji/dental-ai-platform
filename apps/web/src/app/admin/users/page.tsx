"use client";

// F3: admin user management. Invite (temp password shown once), disable /
// re-enable (same-day termination — takes effect within the guard's 30s
// cache), role + location pinning, password/MFA resets, linked SSO identities.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, Td, Th, fmtDate } from "@/components/ui";

interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: string;
  locationId: number | null;
  disabledAt: string | null;
  mfaEnrolled: boolean;
  hasPassword: boolean;
  createdAt: string;
  identities: Array<{ issuer: string; email: string; lastLoginAt: string | null }>;
}

interface UsersPayload {
  locations: Array<{ id: number; name: string }>;
  users: AdminUser[];
}

const inputCls =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal";
const selectCls =
  "rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-teal";
const actionCls =
  "rounded-md border border-line px-2 py-1 text-xs text-ink-soft transition hover:border-teal hover:text-teal";

export default function AdminUsersPage() {
  const { user: me } = useApp();
  const [data, setData] = useState<UsersPayload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invite, setInvite] = useState({ email: "", name: "", role: "staff", locationId: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => api<UsersPayload>("/portal/admin/users").then(setData).catch((e) => setError((e as Error).message)),
    []
  );
  useEffect(() => { void load(); }, [load]);

  if (me.role !== "admin") {
    return (
      <>
        <PageTitle kicker="Administration" title="Users" />
        <Card><Empty text="User management requires the admin role." /></Card>
      </>
    );
  }

  async function act(path: string, done?: (res: any) => void) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api<any>(path, { method: "POST", body: JSON.stringify({}) });
      done?.(res);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api(`/portal/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ email: string; tempPassword: string }>("/portal/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: invite.email,
          name: invite.name,
          role: invite.role,
          locationId: invite.locationId ? Number(invite.locationId) : null
        })
      });
      setNotice(`Invited ${res.email}. Temporary password (shown once): ${res.tempPassword}`);
      setInvite({ email: "", name: "", role: "staff", locationId: "" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle kicker="Administration" title="Users" />

      {notice && (
        <div className="rise mb-4 rounded-md border border-teal/40 bg-mint/40 px-4 py-3 text-sm text-pine">
          {notice}
        </div>
      )}
      {error && (
        <div className="rise mb-4 rounded-md border border-coral/40 bg-coral-soft px-4 py-3 text-sm text-coral">
          {error}
        </div>
      )}

      <div className="space-y-6">
        <Card title="Invite a user">
          <form onSubmit={submitInvite} className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-5">
            <label className="block col-span-2 md:col-span-1">
              <span className="text-[11px] uppercase tracking-widest text-ink-faint">Email</span>
              <input className={inputCls} value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} placeholder="name@practice.dev" />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-ink-faint">Name</span>
              <input className={inputCls} value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-ink-faint">Role</span>
              <select className={inputCls} value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                <option value="staff">staff</option>
                <option value="provider">provider</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-ink-faint">Location</span>
              <select className={inputCls} value={invite.locationId} onChange={(e) => setInvite({ ...invite, locationId: e.target.value })}>
                <option value="">All (org-wide)</option>
                {data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button
                disabled={busy || !invite.email.trim() || !invite.name.trim()}
                className="w-full rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine-2 disabled:opacity-60"
              >
                Invite
              </button>
            </div>
          </form>
        </Card>

        <Card title={`Users (${data?.users.length ?? 0})`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <Th>User</Th><Th>Role</Th><Th>Location</Th><Th>MFA</Th><Th>SSO</Th><Th>Status</Th><Th>Since</Th><Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {!data && (<tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-ink-faint">Loading…</td></tr>)}
                {data?.users.map((u) => {
                  const self = u.id === me.sub;
                  return (
                    <tr key={u.id} className={`border-b border-line/50 ${u.disabledAt ? "opacity-60" : ""}`}>
                      <Td>
                        <div className="font-medium">{u.name}{self && <span className="ml-2 text-[10px] uppercase text-ink-faint">you</span>}</div>
                        <div className="text-xs text-ink-faint">{u.email}</div>
                      </Td>
                      <Td>
                        <select
                          className={selectCls}
                          value={u.role}
                          disabled={busy || self}
                          onChange={(e) => void patch(u.id, { role: e.target.value })}
                        >
                          <option value="staff">staff</option>
                          <option value="provider">provider</option>
                          <option value="admin">admin</option>
                        </select>
                      </Td>
                      <Td>
                        <select
                          className={selectCls}
                          value={u.locationId ?? ""}
                          disabled={busy}
                          onChange={(e) => void patch(u.id, { locationId: e.target.value ? Number(e.target.value) : null })}
                        >
                          <option value="">org-wide</option>
                          {data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      </Td>
                      <Td>{u.mfaEnrolled ? <Chip value="active" /> : <span className="text-xs text-ink-faint">—</span>}</Td>
                      <Td>
                        {u.identities.length === 0
                          ? <span className="text-xs text-ink-faint">—</span>
                          : u.identities.map((i) => (
                              <div key={i.issuer} className="text-xs text-ink-soft" title={`last login ${i.lastLoginAt ? fmtDate(i.lastLoginAt) : "never"}`}>
                                {new URL(i.issuer).hostname}
                              </div>
                            ))}
                      </Td>
                      <Td>{u.disabledAt ? <Chip value="inactive" /> : <Chip value="active" />}</Td>
                      <Td className="text-xs text-ink-faint">{fmtDate(u.createdAt)}</Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {u.disabledAt ? (
                            <button className={actionCls} disabled={busy} onClick={() => void act(`/portal/admin/users/${u.id}/enable`)}>
                              Enable
                            </button>
                          ) : (
                            <button className={actionCls} disabled={busy || self} onClick={() => void act(`/portal/admin/users/${u.id}/disable`)}>
                              Disable
                            </button>
                          )}
                          <button
                            className={actionCls}
                            disabled={busy}
                            onClick={() => void act(`/portal/admin/users/${u.id}/reset-password`, (r) =>
                              setNotice(`New temporary password for ${u.email} (shown once): ${r.tempPassword}`))}
                          >
                            Reset pw
                          </button>
                          {u.mfaEnrolled && (
                            <button className={actionCls} disabled={busy} onClick={() => void act(`/portal/admin/users/${u.id}/reset-mfa`)}>
                              Reset MFA
                            </button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
