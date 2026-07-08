"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, api, setSession, type SessionUser } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@dental.dev");
  const [password, setPassword] = useState("dental-demo");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; providerName: string } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/auth/sso/status`)
      .then((r) => r.json())
      .then(setSso)
      .catch(() => setSso(null));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: SessionUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      setSession(res.token, res.user);
      router.replace("/");
    } catch {
      setError("Invalid credentials. Try admin@dental.dev / dental-demo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grain relative grid min-h-screen place-items-center overflow-hidden bg-pine">
      <div
        className="pointer-events-none absolute -right-40 -top-40 h-[34rem] w-[34rem] rounded-full opacity-25"
        style={{ background: "radial-gradient(circle, #7fa593 0%, transparent 65%)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-52 -left-32 h-[30rem] w-[30rem] rounded-full opacity-20"
        style={{ background: "radial-gradient(circle, #12806e 0%, transparent 65%)" }}
      />
      <div className="rise w-[24rem] rounded-xl border border-pine-2 bg-paper p-8 shadow-2xl">
        <div className="font-display text-4xl font-semibold tracking-tight text-pine">Dental AI</div>
        <div className="mt-1 text-[11px] uppercase tracking-[0.24em] text-teal">
          The operating system for dentistry
        </div>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-widest text-ink-faint">Email</span>
            <input
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-widest text-ink-faint">Password</span>
            <input
              type="password"
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-teal"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="text-sm text-coral">{error}</div>}
          <button
            disabled={busy}
            className="w-full rounded-md bg-pine py-2.5 text-sm font-semibold text-white transition hover:bg-pine-2 disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
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
          admin@dental.dev · frontdesk@dental.dev · drpatel@dental.dev
        </div>
      </div>
    </div>
  );
}
