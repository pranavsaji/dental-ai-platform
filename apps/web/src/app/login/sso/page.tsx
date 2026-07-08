"use client";

// SSO landing page. The API's /auth/sso/callback redirects here with the
// session JWT in the URL fragment (fragments never reach server logs). We
// validate it against /auth/me, persist the session, and enter the app.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL, setSession, type SessionUser } from "@/lib/api";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "SSO is not configured on this server.",
  no_account: "No account matches your SSO identity. Ask an admin to invite you.",
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
    window.history.replaceState(null, "", "/login/sso"); // scrub token from the URL bar
    const err = params.get("error");
    if (err) {
      setError(ERROR_MESSAGES[err] ?? `Sign-in failed (${err}).`);
      return;
    }
    const token = params.get("token");
    if (!token) {
      setError("Missing sign-in token. Please start over.");
      return;
    }
    fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error("invalid token");
        return r.json() as Promise<SessionUser>;
      })
      .then((user) => {
        setSession(token, user);
        router.replace("/");
      })
      .catch(() => setError("Sign-in could not be verified. Please try again."));
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-pine">
      <div className="w-[24rem] rounded-xl border border-pine-2 bg-paper p-8 text-center shadow-2xl">
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
