"use client";

// One-line import for pages: keeps three.js out of their chunk until the
// backdrop actually mounts on the client.

import dynamic from "next/dynamic";

export const AmbientBackdrop = dynamic(
  () => import("./ambient-backdrop").then((m) => m.AmbientBackdrop),
  { ssr: false }
);
