"use client";

// SSO landing page. F2: the API's /auth/sso/callback sets the httpOnly
// session cookies itself and redirects here with a bare #sso=ok marker — no
// token ever appears in a URL. We confirm the cookie works via /auth/me,
// persist the (non-sensitive) profile for the shell, and enter the app.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, setSession, type SessionUser } from "@/lib/api";
import { LoginFallback } from "@/components/three/login-fallback";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "SSO is not configured on this server.",
  no_account: "No account matches your SSO identity. Ask an admin to invite you.",
  account_disabled: "Your account has been disabled. Contact an administrator.",
  domain_not_allowed: "Your email domain is not allowed for this organization.",
  email_unverified: "Your identity provider reports this email as unverified.",
  idp_unreachable: "Could not reach the identity provider.",
  invalid_token: "Sign-in could not be verified. Please try again.",
  expired_transaction: "The sign-in attempt expired. Please try again.",
  state_mismatch: "The sign-in attempt could not be validated. Please try again."
};

export default function SsoLandingPage() {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", "/login/sso"); // scrub the fragment
    const err = params.get("error");
    if (err) {
      setError(ERROR_MESSAGES[err] ?? `Sign-in failed (${err}).`);
      return;
    }
    if (params.get("sso") !== "ok") {
      setError("Missing sign-in confirmation. Please start over.");
      return;
    }
    fetch(`${API_URL}/auth/me`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("invalid session");
        return r.json() as Promise<SessionUser>;
      })
      .then((user) => {
        setSession(user);
        router.replace("/");
      })
      .catch(() => setError("Sign-in could not be verified. Please try again."));
  }, [router]);

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-pine-deep">
      <LoginFallback />
      <div className="relative z-10 w-[24rem] rounded-xl border border-white/10 bg-paper p-8 text-center shadow-[var(--shadow-xl)]">
        <div className="font-display text-3xl font-semibold text-pine">Dental AI</div>
        {error ? (
          <>
            <div className="mt-4 text-sm text-coral">{error}</div>
            <a href="/login" className="mt-4 inline-block text-sm font-semibold text-teal underline">
              Back to sign in
            </a>
          </>
        ) : (
          <div className="mt-4 text-sm text-ink-faint">Completing sign-in…</div>
        )}
      </div>
    </div>
  );
}
