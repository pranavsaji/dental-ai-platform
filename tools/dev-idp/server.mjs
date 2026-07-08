// Local OIDC identity provider for developing/testing SSO without a real
// IdP (Google/Okta/Azure AD). Zero dependencies: RS256 keypair is generated at
// startup, ID tokens are hand-assembled JWTs, PKCE (S256) is enforced.
//
//   node tools/dev-idp/server.mjs          # listens on :9400
//
// Point the API at it via .env:
//   OIDC_ISSUER=http://localhost:9400
//   OIDC_CLIENT_ID=dental-web
//   OIDC_CLIENT_SECRET=dev-idp-secret
//
// /authorize renders a user picker; append &auto=1&email=... for headless use.

import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.DEV_IDP_PORT ?? 9400);
const ISSUER = process.env.DEV_IDP_ISSUER ?? `http://localhost:${PORT}`;
const CLIENT_ID = process.env.DEV_IDP_CLIENT_ID ?? "dental-web";
const CLIENT_SECRET = process.env.DEV_IDP_CLIENT_SECRET ?? "dev-idp-secret";
const KID = "dev-idp-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const codes = new Map(); // code -> { email, name, nonce, redirectUri, challenge, exp }

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function signIdToken(claims) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

function authorizePage(q) {
  const hidden = ["client_id", "redirect_uri", "state", "nonce", "code_challenge", "code_challenge_method", "scope", "response_type"]
    .filter((k) => q.get(k))
    .map((k) => `<input type="hidden" name="${k}" value="${q.get(k).replace(/"/g, "&quot;")}">`)
    .join("\n");
  return `<!doctype html><html><body style="font-family:system-ui;max-width:26rem;margin:8rem auto">
  <h2>DEV IdP — sign in</h2>
  <p style="color:#666">Local OIDC provider for SSO testing. Any email works; provisioning rules live in the platform API.</p>
  <form method="GET" action="/authorize">
    ${hidden}
    <input type="hidden" name="auto" value="1">
    <input name="email" value="admin@dental.dev" style="width:100%;padding:.5rem;font-size:1rem">
    <input name="name" value="Dana Admin" style="width:100%;padding:.5rem;font-size:1rem;margin-top:.5rem">
    <button style="margin-top:1rem;padding:.5rem 1.5rem;font-size:1rem">Continue</button>
  </form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);

  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email", "profile"]
    });
  }

  if (url.pathname === "/jwks") {
    const jwk = publicKey.export({ format: "jwk" });
    return json(res, 200, { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
  }

  if (url.pathname === "/authorize" && req.method === "GET") {
    const q = url.searchParams;
    if (q.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "unknown client_id" });
    if (!q.get("redirect_uri") || !q.get("state") || !q.get("code_challenge")) {
      return json(res, 400, { error: "missing redirect_uri/state/code_challenge" });
    }
    if (q.get("auto") !== "1" || !q.get("email")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(authorizePage(q));
    }
    const code = b64url(crypto.randomBytes(24));
    codes.set(code, {
      email: q.get("email").toLowerCase().trim(),
      name: q.get("name") || q.get("email"),
      nonce: q.get("nonce") ?? "",
      redirectUri: q.get("redirect_uri"),
      challenge: q.get("code_challenge"),
      exp: Date.now() + 120_000
    });
    const target = new URL(q.get("redirect_uri"));
    target.searchParams.set("code", code);
    target.searchParams.set("state", q.get("state"));
    res.writeHead(302, { location: target.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
    if (!grant || grant.exp < Date.now()) return json(res, 400, { error: "invalid_grant" });
    if (form.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "invalid_client" });
    if (form.get("client_secret") && form.get("client_secret") !== CLIENT_SECRET) {
      return json(res, 401, { error: "invalid_client_secret" });
    }
    if (form.get("redirect_uri") !== grant.redirectUri) return json(res, 400, { error: "redirect_uri_mismatch" });
    const expected = b64url(crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest());
    if (expected !== grant.challenge) return json(res, 400, { error: "pkce_verification_failed" });

    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: `dev-idp|${grant.email}`,
      email: grant.email,
      email_verified: true,
      name: grant.name,
      nonce: grant.nonce,
      iat: now,
      exp: now + 300
    });
    return json(res, 200, {
      access_token: b64url(crypto.randomBytes(24)),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken
    });
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log(`[dev-idp] OIDC provider at ${ISSUER} (client_id=${CLIENT_ID})`));
