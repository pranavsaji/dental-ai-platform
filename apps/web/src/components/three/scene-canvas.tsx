"use client";

// The one shared react-three-fiber wrapper. Every 3D scene mounts through
// this so the guardrails live in a single place:
//   - WebGL unavailable / context creation fails → render the CSS fallback
//   - prefers-reduced-motion → render a single static frame, no animation
//   - hidden tab → stop the frameloop entirely
//   - AdaptiveDpr + PerformanceMonitor demote resolution on weak GPUs
//   - any GL error is caught by an error boundary → CSS fallback

import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { AdaptiveDpr, PerformanceMonitor } from "@react-three/drei";
import {
  usePageVisible,
  usePrefersReducedMotion,
  useWebGLAvailable
} from "@/lib/capabilities";

class GLErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Renders exactly one frame when reduced motion is on, then halts.
function StaticFrame({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (active) invalidate();
  }, [active, invalidate]);
  return null;
}

export function SceneCanvas({
  children,
  fallback,
  dpr = [1, 1.75],
  className = ""
}: {
  children: ReactNode;
  fallback: ReactNode;
  dpr?: [number, number];
  className?: string;
}) {
  const webgl = useWebGLAvailable();
  const reduced = usePrefersReducedMotion();
  const visible = usePageVisible();
  const [degraded, setDegraded] = useState(false);
  const [lost, setLost] = useState(false);

  if (webgl !== true || lost) return <>{fallback}</>;

  const frameloop = !visible ? "never" : reduced ? "demand" : "always";

  return (
    <GLErrorBoundary fallback={fallback}>
      <div className={className} aria-hidden="true" role="presentation">
        <Canvas
          dpr={degraded ? 1 : dpr}
          frameloop={frameloop}
          gl={{
            antialias: true,
            alpha: true,
            powerPreference: "high-performance",
            failIfMajorPerformanceCaveat: true
          }}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener("webglcontextlost", (e) => {
              e.preventDefault();
              setLost(true);
            });
          }}
        >
          <Suspense fallback={null}>
            <PerformanceMonitor onDecline={() => setDegraded(true)}>
              <AdaptiveDpr />
              <StaticFrame active={reduced} />
              {children}
            </PerformanceMonitor>
          </Suspense>
        </Canvas>
      </div>
    </GLErrorBoundary>
  );
}
