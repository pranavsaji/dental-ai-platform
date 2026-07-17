"use client";

// Spring-driven count-up for KPI values. Renders inside a .num span so
// tabular figures keep the layout stable while the value animates.
// Snaps instantly when the user prefers reduced motion.

import { useEffect, useRef, useState } from "react";
import { useSpring } from "motion/react";
import { usePrefersReducedMotion } from "@/lib/capabilities";

export function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toLocaleString(),
  className = ""
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const spring = useSpring(0, { stiffness: 90, damping: 24 });
  const [display, setDisplay] = useState(() => format(0));
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    if (reduced) {
      spring.jump(value);
    } else {
      spring.set(value);
    }
  }, [value, reduced, spring]);

  useEffect(() => {
    setDisplay(formatRef.current(spring.get()));
    return spring.on("change", (v) => setDisplay(formatRef.current(v)));
  }, [spring]);

  return <span className={`num ${className}`}>{display}</span>;
}
