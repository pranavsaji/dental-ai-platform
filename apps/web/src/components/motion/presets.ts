// Shared motion vocabulary. Every page pulls from these so the whole app
// moves with one voice. EASE matches the original CSS .rise curve.

import type { Variants, Transition } from "motion/react";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const SPRING_SOFT: Transition = { type: "spring", stiffness: 260, damping: 30 };
export const SPRING_SNAPPY: Transition = { type: "spring", stiffness: 420, damping: 32 };

export const riseIn: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }
};

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } }
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } }
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -4 },
  show: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
  exit: { opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.15, ease: "easeIn" } }
};

export const fadeSwap: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18, ease: "easeIn" } }
};
