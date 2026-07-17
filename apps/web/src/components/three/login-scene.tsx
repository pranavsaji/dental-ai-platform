"use client";

// The login showpiece: deep-pine aurora ink wash + drifting motes, with a
// CSS vignette over the canvas so the form card sits in calm space. Loaded
// only via next/dynamic ssr:false from the login page.

import { SceneCanvas } from "./scene-canvas";
import { AuroraPlane } from "./aurora-plane";
import { ParticleDrift } from "./particle-drift";
import { LoginFallback } from "./login-fallback";

export default function LoginScene() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <SceneCanvas fallback={<LoginFallback />} dpr={[1, 1.75]} className="absolute inset-0">
        <AuroraPlane timeScale={0.05} intensity={1} coralAmount={1} />
        <ParticleDrift count={900} />
      </SceneCanvas>
      {/* vignette + bottom shade so the card and footer text stay legible */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 70% at 50% 42%, transparent 45%, rgba(9,46,40,0.4) 100%)"
        }}
      />
    </div>
  );
}
