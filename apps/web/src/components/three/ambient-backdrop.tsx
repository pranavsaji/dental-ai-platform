"use client";

// The in-app version of the aurora: a paper-toned shader band that sits
// behind a page's title + KPI area — light through a window, not a light
// show. Unmounts the canvas entirely when scrolled out of view.

import { useEffect, useRef, useState } from "react";
import { SceneCanvas } from "./scene-canvas";
import { AuroraPlane } from "./aurora-plane";

// Static CSS approximation used as the fallback and while offscreen.
function AmbientFallback() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(80% 120% at 15% 0%, rgba(220,237,228,0.55), transparent 60%)," +
          "radial-gradient(70% 110% at 85% 10%, rgba(246,234,209,0.4), transparent 55%)," +
          "radial-gradient(60% 100% at 50% 0%, rgba(185,220,201,0.3), transparent 60%)"
      }}
    />
  );
}

export function AmbientBackdrop({ height = 340 }: { height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: "80px"
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden opacity-80"
      style={{
        height,
        maskImage: "linear-gradient(to bottom, black 30%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, black 30%, transparent)"
      }}
    >
      {inView ? (
        <SceneCanvas fallback={<AmbientFallback />} dpr={[1, 1.5]} className="absolute inset-0">
          <AuroraPlane
            timeScale={0.03}
            intensity={1}
            coralAmount={0.15}
            parallax={false}
            colors={{ a: "#f6f4ee", b: "#eef2ea", c: "#dcede4", d: "#f6ead1" }}
          />
        </SceneCanvas>
      ) : (
        <AmbientFallback />
      )}
    </div>
  );
}
