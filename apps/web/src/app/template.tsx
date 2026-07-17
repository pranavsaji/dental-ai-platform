"use client";

// App Router remounts template.tsx on every navigation, which gives each
// route a fresh entrance animation for free. Entrance only — exit
// animations are unreliable in the App Router by design.

import { m } from "motion/react";
import { EASE } from "@/components/motion/presets";

export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
    >
      {children}
    </m.div>
  );
}
