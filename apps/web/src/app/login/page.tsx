"use client";

// Login. F2: the API answers a password login one of three ways —
//   {user}                      → session cookie set, enter the app
//   {mfaRequired, mfaToken}     → ask for the 6-digit TOTP (or recovery) code
//   {mfaSetupRequired, mfaToken}→ enforced admin without MFA: enroll inline
//                                 (QR → confirm code → recovery codes) and
//                                 continue into a session.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { API_URL, api, setSession, type SessionUser } from "@/lib/api";
import { m, AnimatePresence } from "@/components/motion/motion";
import { fadeSwap } from "@/components/motion/presets";
import { LoginFallback } from "@/components/three/login-fallback";

const LoginScene = dynamic(() => import("@/components/three/login-scene"), {
  ssr: false,
  loading: () => <LoginFallback />
});

type LoginResponse =
  | { user: SessionUser; token?: string }
  | { mfaRequired: true; mfaToken: string }
  | { mfaSetupRequired: true; mfaToken: string };

type Step =
  | { kind: "credentials" }
  | { kind: "mfa_code"; mfaToken: string }
  | { kind: "mfa_setup"; mfaToken: string; qrDataUrl: string; secret: string }
  | { kind: "recovery_codes"; codes: string[] };

const inputCls =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal";

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <line x1="4" y1="20" x2="20" y2="4" />}
    </svg>
  );
}
const buttonCls =
  "w-full rounded-md bg-pine py-2.5 text-sm font-semibold text-white transition hover:bg-pine-2 disabled:opacity-60";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@dental.dev");
  const [password, setPassword] = useState("dental-demo");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; providerName: string; issuerIsLocal?: boolean } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/auth/sso/status`)
      .then((r) => r.json())
      // A localhost dev IdP is unreachable for hosted visitors — only offer SSO
      // for it when the app itself is running on localhost.
      .then((s) => {
        const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
        setSso(s.issuerIsLocal && !onLocalhost ? { ...s, enabled: false } : s);
      })
      .catch(() => setSso(null));
  }, []);

  function enter(user: SessionUser) {
    setSession(user);
    router.replace("/");
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      if ("mfaRequired" in res) {
        setStep({ kind: "mfa_code", mfaToken: res.mfaToken });
      } else if ("mfaSetupRequired" in res) {
        const setup = await api<{ qrDataUrl: string; secret: string }>("/auth/mfa/setup/start", {
          method: "POST",
          body: JSON.stringify({ mfaToken: res.mfaToken })
        });
        setStep({ kind: "mfa_setup", mfaToken: res.mfaToken, ...setup });
      } else {
        enter(res.user);
      }
    } catch {
      setError("Invalid credentials. Try admin@dental.dev / dental-demo");
    } finally {
      setBusy(false);
    }
  }

  async function submitMfaCode(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "mfa_code") return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ user: SessionUser }>("/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ mfaToken: step.mfaToken, code })
      });
      enter(res.user);
    } catch {
      setError("That code didn't match. Try again, or use a recovery code.");
    } finally {
      setBusy(false);
    }
  }

  async function submitMfaSetup(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "mfa_setup") return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ recoveryCodes: string[]; user: SessionUser }>("/auth/mfa/setup/confirm", {
        method: "POST",
        body: JSON.stringify({ mfaToken: step.mfaToken, code })
      });
      setSession(res.user);
      setStep({ kind: "recovery_codes", codes: res.recoveryCodes });
    } catch {
      setError("That code didn't match — rescan the QR and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grain relative grid min-h-screen place-items-center overflow-hidden bg-pine-deep">
      <div className="pointer-events-none absolute inset-0">
        <LoginScene />
      </div>
      <m.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-[24rem] rounded-xl border border-white/10 bg-paper p-8 shadow-[var(--shadow-xl)]"
      >
        <div className="text-center font-display text-4xl font-semibold tracking-tight text-pine">Dental AI</div>
        <div className="mt-1 text-center text-[11px] uppercase tracking-[0.24em] text-teal">
          The operating system for dentistry
        </div>

        <AnimatePresence mode="wait" initial={false}>
        {step.kind === "credentials" && (
          <m.div key="credentials" variants={fadeSwap} initial="hidden" animate="show" exit="exit">
            <form onSubmit={submitCredentials} className="mt-8 space-y-4">
              <label className="block">
                <span className="text-[11px] uppercase tracking-widest text-ink-faint">Email</span>
                <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-widest text-ink-faint">Password</span>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    className={`${inputCls} pr-10`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 mt-1 flex w-10 items-center justify-center text-ink-faint transition hover:text-ink"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    <EyeIcon off={!showPassword} />
                  </button>
                </div>
              </label>
              {error && <div className="text-sm text-coral">{error}</div>}
              <button disabled={busy} className={buttonCls}>{busy ? "Signing in…" : "Sign in"}</button>
            </form>
            {sso?.enabled && (
              <>
                <div className="mt-4 flex items-center gap-3 text-[10px] uppercase tracking-widest text-ink-faint">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
                <a
                  href={`${API_URL}/auth/sso/login`}
                  className="mt-4 block w-full rounded-md border border-pine py-2.5 text-center text-sm font-semibold text-pine transition hover:bg-surface"
                >
                  Continue with {sso.providerName}
                </a>
              </>
            )}
            <div className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-ink-faint">
              Demo users (password <span className="num">dental-demo</span>):<br />
              admin@dental.dev (owner) · frontdesk@dental.dev (front desk)<br />
              drpatel@dental.dev (doctor) · billing@dental.dev (billing)
            </div>
          </m.div>
        )}

        {step.kind === "mfa_code" && (
          <m.form key="mfa_code" variants={fadeSwap} initial="hidden" animate="show" exit="exit" onSubmit={submitMfaCode} className="mt-8 space-y-4">
            <div className="text-sm text-ink-soft">
              Enter the 6-digit code from your authenticator app (or a recovery code).
            </div>
            <input
              className={`${inputCls} num text-center text-lg tracking-[0.3em]`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              autoComplete="one-time-code"
              placeholder="123456"
            />
            {error && <div className="text-sm text-coral">{error}</div>}
            <button disabled={busy || !code.trim()} className={buttonCls}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button type="button" className="w-full text-xs text-ink-faint underline" onClick={() => { setStep({ kind: "credentials" }); setCode(""); setError(""); }}>
              Back to sign in
            </button>
          </m.form>
        )}

        {step.kind === "mfa_setup" && (
          <m.form key="mfa_setup" variants={fadeSwap} initial="hidden" animate="show" exit="exit" onSubmit={submitMfaSetup} className="mt-8 space-y-4">
            <div className="text-sm text-ink-soft">
              Your admin account requires two-factor authentication. Scan this QR
              with an authenticator app, then enter the code it shows.
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.qrDataUrl} alt="TOTP enrollment QR code" className="mx-auto h-44 w-44 rounded-md border border-line bg-white p-2" />
            <div className="break-all text-center text-[10px] text-ink-faint">
              Manual key: <span className="num">{step.secret}</span>
            </div>
            <input
              className={`${inputCls} num text-center text-lg tracking-[0.3em]`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              placeholder="123456"
            />
            {error && <div className="text-sm text-coral">{error}</div>}
            <button disabled={busy || !code.trim()} className={buttonCls}>
              {busy ? "Confirming…" : "Confirm & sign in"}
            </button>
          </m.form>
        )}

        {step.kind === "recovery_codes" && (
          <m.div key="recovery_codes" variants={fadeSwap} initial="hidden" animate="show" exit="exit" className="mt-8 space-y-4">
            <div className="text-sm text-ink-soft">
              MFA is on. Save these one-time recovery codes somewhere safe — they
              are shown only once.
            </div>
            <div className="num grid grid-cols-2 gap-2 rounded-md border border-line bg-surface p-4 text-center text-sm">
              {step.codes.map((c) => <div key={c}>{c}</div>)}
            </div>
            <button className={buttonCls} onClick={() => router.replace("/")}>Continue</button>
          </m.div>
        )}
        </AnimatePresence>
      </m.div>
    </div>
  );
}
