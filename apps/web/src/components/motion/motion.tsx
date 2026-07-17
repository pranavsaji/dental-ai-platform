"use client";

// Thin motion layer over `motion/react`. LazyMotion + m.* keeps the initial
// bundle small; MotionConfig honors the user's reduced-motion setting.
// domMax (not domAnimation) because the sidebar nav pill uses layoutId.
// <Rise>/<StaggerList>/<StaggerItem> replace the old CSS .rise / .rise-1..4.

import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { riseIn, staggerParent, staggerItem } from "./presets";

export { m } from "motion/react";
export { AnimatePresence } from "motion/react";

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMax} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}

export function Rise({
  children,
  delay = 0,
  className = ""
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </m.div>
  );
}

export function StaggerList({
  children,
  className = ""
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <m.div className={className} variants={staggerParent} initial="hidden" animate="show">
      {children}
    </m.div>
  );
}

export function StaggerItem({
  children,
  className = ""
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <m.div className={className} variants={staggerItem}>
      {children}
    </m.div>
  );
}

export { riseIn, staggerParent, staggerItem };
