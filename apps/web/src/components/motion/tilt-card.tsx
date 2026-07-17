"use client";

// Pointer-tracked 3D tilt with a following sheen highlight. Subtle by
// design (±4°). Renders children untouched on coarse pointers or when
// the user prefers reduced motion.

import { useRef } from "react";
import { m, useMotionValue, useSpring, useTransform } from "motion/react";
import { useCoarsePointer, usePrefersReducedMotion } from "@/lib/capabilities";

export function TiltCard({
  children,
  maxTilt = 4,
  className = ""
}: {
  children: React.ReactNode;
  maxTilt?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const coarse = useCoarsePointer();
  const ref = useRef<HTMLDivElement>(null);

  const px = useMotionValue(0.5); // pointer position 0..1 within the card
  const py = useMotionValue(0.5);
  const sx = useSpring(px, { stiffness: 300, damping: 30 });
  const sy = useSpring(py, { stiffness: 300, damping: 30 });
  const rotateX = useTransform(sy, [0, 1], [maxTilt, -maxTilt]);
  const rotateY = useTransform(sx, [0, 1], [-maxTilt, maxTilt]);
  const sheenX = useTransform(sx, [0, 1], ["20%", "80%"]);
  const sheenY = useTransform(sy, [0, 1], ["20%", "80%"]);
  const sheen = useTransform(
    [sheenX, sheenY],
    ([x, y]) =>
      `radial-gradient(280px circle at ${x} ${y}, rgba(255,255,255,0.28), transparent 65%)`
  );

  if (reduced || coarse) {
    return <div className={className}>{children}</div>;
  }

  return (
    <m.div
      ref={ref}
      className={`group/tilt relative ${className}`}
      style={{ rotateX, rotateY, transformPerspective: 900 }}
      onPointerMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
      }}
      onPointerLeave={() => {
        px.set(0.5);
        py.set(0.5);
      }}
    >
      {children}
      <m.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/tilt:opacity-100"
        style={{ background: sheen }}
      />
    </m.div>
  );
}
