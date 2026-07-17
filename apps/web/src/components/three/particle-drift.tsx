"use client";

// ~900 soft mint/sage motes drifting slowly upward. All motion happens in
// the vertex shader (per-particle phase from a seed attribute), so the CPU
// does zero per-frame work beyond bumping uTime.

import { useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

const VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
varying float vAlpha;
varying vec3 vColor;

void main() {
  vec3 p = position;
  float t = uTime * 0.05;

  // slow upward drift with per-particle phase; wrap vertically
  p.y = mod(p.y + t * (0.4 + aSeed * 0.6) + aSeed * 8.0, 8.0) - 4.0;
  p.x += sin(t * 2.0 + aSeed * 40.0) * 0.15;

  // fade near vertical wrap edges so respawns are invisible
  vAlpha = smoothstep(4.0, 3.2, abs(p.y)) * (0.25 + aSeed * 0.25);
  vColor = mix(vec3(0.86, 0.93, 0.89), vec3(0.5, 0.65, 0.58), aSeed);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.0 + aSeed * 4.0) * (12.0 / max(-mv.z, 0.1));
}
`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float soft = smoothstep(0.5, 0.1, d);
  gl_FragColor = vec4(vColor, soft * vAlpha);
}
`;

export function ParticleDrift({ count = 900 }: { count?: number }) {
  const { geometry, material } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    // deterministic pseudo-random spread (mulberry-ish hash on index)
    for (let i = 0; i < count; i++) {
      const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const h2 = Math.sin(i * 269.5 + 183.3) * 28001.8384;
      const h3 = Math.sin(i * 419.2 + 371.9) * 61423.1237;
      positions[i * 3] = ((h - Math.floor(h)) - 0.5) * 12;
      positions[i * 3 + 1] = ((h2 - Math.floor(h2)) - 0.5) * 8;
      positions[i * 3 + 2] = ((h3 - Math.floor(h3)) - 0.5) * 4 - 1;
      seeds[i] = h3 - Math.floor(h3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    return { geometry: geo, material: mat };
  }, [count]);

  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <points geometry={geometry} material={material} />;
}
