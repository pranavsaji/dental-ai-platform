"use client";

// CSS-only backdrop: what the login shows while the WebGL scene loads,
// when WebGL is unavailable, or on the SSO redirect page. Approximates the
// aurora palette with slow-breathing radial blobs (motion is guarded by
// prefers-reduced-motion in globals.css conventions via inline media query).

export function LoginFallback() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden bg-pine-deep">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes blob-breathe {
            0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.8; }
            50% { transform: translate(3%, -4%) scale(1.08); opacity: 1; }
          }
          .blob-a { animation: blob-breathe 14s ease-in-out infinite; }
          .blob-b { animation: blob-breathe 18s ease-in-out 3s infinite; }
        }
      `}</style>
      <div
        className="blob-a absolute -left-1/4 -top-1/4 h-[80%] w-[80%] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(18,128,110,0.35), transparent 65%)"
        }}
      />
      <div
        className="blob-b absolute -bottom-1/4 -right-1/4 h-[75%] w-[75%] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(127,165,147,0.28), transparent 65%)"
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 110%, rgba(217,79,43,0.08), transparent 55%)"
        }}
      />
    </div>
  );
}
