"use client";

// F2: account & security. Any user can enroll TOTP MFA here voluntarily;
// admins are forced through the same flow at login when enforcement is on.
// Lost authenticators are reset by an admin from /admin/users.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, PageTitle } from "@/components/ui";

interface MfaStatus {
  enrolled: boolean;
  enforcedForAdmins: boolean;
  recoveryCodesLeft: number;
}

const inputCls =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal";
const buttonCls =
  "rounded-md bg-pine px-4 py-2 text-sm font-semibold text-white transition hover:bg-pine-2 disabled:opacity-60";

export default function AccountPage() {
  const { user } = useApp();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = () => api<MfaStatus>("/auth/mfa/status").then(setStatus).catch(() => {});
  useEffect(() => { void loadStatus(); }, []);

  async function startEnroll() {
    setBusy(true);
    setError("");
    try {
      setSetup(await api<{ qrDataUrl: string; secret: string }>("/auth/mfa/setup/start", {
        method: "POST", body: JSON.stringify({})
      }));
    } catch (e) {
      setError((e as Error).message || "Could not start enrollment");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ recoveryCodes: string[] }>("/auth/mfa/setup/confirm", {
        method: "POST", body: JSON.stringify({ code })
      });
      setRecoveryCodes(res.recoveryCodes);
      setSetup(null);
      setCode("");
      void loadStatus();
    } catch {
      setError("That code didn't match — check your authenticator app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle kicker="Security" title="Account" />
      <div className="max-w-2xl space-y-6">
        <Card title="Profile">
          <div className="space-y-1 px-5 py-4 text-sm">
            <div><span className="text-ink-faint">Name:</span> {user.name}</div>
            <div><span className="text-ink-faint">Email:</span> {user.email}</div>
            <div><span className="text-ink-faint">Role:</span> {user.role}</div>
          </div>
        </Card>

        <Card title="Two-factor authentication">
          <div className="space-y-4 px-5 py-4 text-sm">
            {!status && <div className="text-ink-faint">Loading…</div>}
            {status && status.enrolled && !recoveryCodes && (
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-mint px-2.5 py-0.5 text-[11px] font-medium text-pine">enabled</span>
                <span className="text-ink-soft">
                  TOTP is on · {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
                  Lost your authenticator? An admin can reset MFA from the Users page.
                </span>
              </div>
            )}
            {status && !status.enrolled && !setup && (
              <>
                <p className="text-ink-soft">
                  Protect your account with a 6-digit code from an authenticator app.
                  {status.enforcedForAdmins && user.role === "admin" && " Required for admin accounts."}
                </p>
                <button className={buttonCls} disabled={busy} onClick={startEnroll}>
                  {busy ? "Starting…" : "Set up MFA"}
                </button>
              </>
            )}
            {setup && (
              <form onSubmit={confirmEnroll} className="space-y-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qrDataUrl} alt="TOTP enrollment QR code" className="h-44 w-44 rounded-md border border-line bg-white p-2" />
                <div className="break-all text-[11px] text-ink-faint">
                  Manual key: <span className="num">{setup.secret}</span>
                </div>
                <label className="block max-w-[14rem]">
                  <span className="text-[11px] uppercase tracking-widest text-ink-faint">Code from the app</span>
                  <input className={`${inputCls} num`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoComplete="one-time-code" />
                </label>
                {error && <div className="text-sm text-coral">{error}</div>}
                <button className={buttonCls} disabled={busy || !code.trim()}>
                  {busy ? "Confirming…" : "Confirm enrollment"}
                </button>
              </form>
            )}
            {recoveryCodes && (
              <div className="space-y-3">
                <p className="text-ink-soft">
                  MFA is on. Save these one-time recovery codes — they are shown only once.
                </p>
                <div className="num grid max-w-sm grid-cols-2 gap-2 rounded-md border border-line bg-surface p-4 text-center">
                  {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
                </div>
                <button className={buttonCls} onClick={() => setRecoveryCodes(null)}>Done</button>
              </div>
            )}
            {error && !setup && <div className="text-sm text-coral">{error}</div>}
          </div>
        </Card>
      </div>
    </>
  );
}
