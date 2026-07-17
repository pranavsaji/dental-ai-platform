"use client";

// Fullscreen plane driving the aurora shader. Attached via <primitive> so
// we avoid JSX-element augmentation for the custom material. Colors and
// pacing are props so the login hero (deep pine) and the in-app ambient
// band (paper tints) share one implementation.

import { useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { AuroraMaterial } from "./shaders/aurora";

export function AuroraPlane({
  timeScale = 0.05,
  intensity = 1,
  colors,
  coralAmount = 1,
  parallax = true
}: {
  timeScale?: number;
  intensity?: number;
  colors?: { a: string; b: string; c: string; d: string };
  coralAmount?: number;
  parallax?: boolean;
}) {
  const material = useMemo(() => {
    const mat = new AuroraMaterial();
    mat.uTimeScale = timeScale;
    mat.uIntensity = intensity;
    mat.uCoralAmount = coralAmount;
    if (colors) {
      mat.uColorA = new THREE.Color(colors.a);
      mat.uColorB = new THREE.Color(colors.b);
      mat.uColorC = new THREE.Color(colors.c);
      mat.uColorD = new THREE.Color(colors.d);
    }
    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((state) => {
    material.uTime = state.clock.elapsedTime;
    material.uResolution.set(state.size.width, state.size.height);
    if (parallax) {
      // state.pointer is -1..1; shader expects 0..1. Lerp for weight.
      material.uPointer.lerp(
        new THREE.Vector2(state.pointer.x * 0.5 + 0.5, state.pointer.y * 0.5 + 0.5),
        0.05
      );
    }
  });

  return (
    // 2x2 plane + clip-space vertex shader = exact fullscreen coverage.
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
