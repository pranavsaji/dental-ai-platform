import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["three"],
  // Hosted deploys proxy API calls through /backend so the session cookies stay
  // first-party (SameSite=Lax survives). API_PROXY_TARGET is the public URL of
  // the control-plane API (e.g. a cloudflared tunnel to :4100); unset locally,
  // where the web app talks to http://localhost:4100 directly.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET?.replace(/\/$/, "");
    if (!target) return [];
    return [{ source: "/backend/:path*", destination: `${target}/:path*` }];
  }
};

export default nextConfig;
