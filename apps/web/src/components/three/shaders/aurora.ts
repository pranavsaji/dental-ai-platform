// Aurora "ink wash" shader — a glacial fbm flow through the brand palette
// (pine-deep → pine → teal → sage) with one thin drifting coral filament.
// Time scale is deliberately tiny: this should feel like light moving
// through water, not a screensaver.

import * as THREE from "three";
import { shaderMaterial } from "@react-three/drei";

// Ashima 2D simplex noise (public domain), inlined — no texture fetches.
const NOISE = /* glsl */ `
vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p = p * 2.05 + vec2(13.7, 7.3);
    a *= 0.5;
  }
  return v;
}
`;

export const AuroraMaterial = shaderMaterial(
  {
    uTime: 0,
    uPointer: new THREE.Vector2(0.5, 0.5),
    uResolution: new THREE.Vector2(1, 1),
    uIntensity: 1.0,
    uTimeScale: 0.05,
    // Brand palette as uniforms so the ambient (paper-toned) variant can
    // reuse the same material with different colors.
    uColorA: new THREE.Color("#092e28"), // pine-deep
    uColorB: new THREE.Color("#0e3b34"), // pine
    uColorC: new THREE.Color("#12806e"), // teal
    uColorD: new THREE.Color("#7fa593"), // sage
    uCoral: new THREE.Color("#d94f2b"),
    uCoralAmount: 1.0
  },
  /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Fullscreen quad in clip space — camera-independent, always covers
    // the canvas exactly (geometry must be a 2x2 plane).
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
  `,
  /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uPointer;
  uniform vec2 uResolution;
  uniform float uIntensity;
  uniform float uTimeScale;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;
  uniform vec3 uCoral;
  uniform float uCoralAmount;
  ${NOISE}
  void main() {
    float t = uTime * uTimeScale;
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y);

    // gentle pointer parallax (pointer is pre-lerped on the CPU side)
    p += (uPointer - 0.5) * 0.08;

    // two drifting noise fields warped into each other: the "ink wash"
    vec2 q = vec2(fbm(p * 1.6 + vec2(t * 0.6, -t * 0.4)),
                  fbm(p * 1.6 + vec2(-t * 0.3, t * 0.5) + 5.2));
    float flow = fbm(p * 2.2 + q * 1.4 + vec2(t * 0.2, t * 0.35));
    float depth = fbm(p * 1.1 - q * 0.8 + vec2(-t * 0.15, t * 0.1));

    // dark base wash, then flowing ribbons of teal and sage — the noise
    // fields carve bright bands out of the dark pine instead of tinting
    // every pixel (which reads as flat gray-green).
    vec3 col = mix(uColorA, uColorB, clamp(0.3 + q.x * 0.8 + uv.y * 0.3, 0.0, 1.0));
    float ribbonTeal = smoothstep(0.4, 0.05, abs(flow - 0.12));
    float ribbonSage = smoothstep(0.28, 0.02, abs(depth - 0.42));
    col = mix(col, uColorC, ribbonTeal * 0.75);
    col = mix(col, uColorD, ribbonSage * 0.5);

    // one thin coral filament — a narrow band on a second noise field
    float band = fbm(p * 1.3 + vec2(t * 0.45, -t * 0.2) + 11.0);
    float filament = smoothstep(0.03, 0.0, abs(band - 0.35) - 0.02);
    col = mix(col, uCoral, filament * 0.55 * uCoralAmount);

    // soft vignette keeps edges calm
    float vig = smoothstep(1.25, 0.35, length(uv - 0.5) * 1.6);
    col *= mix(0.88, 1.0, vig);

    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
  `
);

export type AuroraUniforms = {
  uTime: number;
  uPointer: THREE.Vector2;
  uResolution: THREE.Vector2;
  uIntensity: number;
  uTimeScale: number;
  uColorA: THREE.Color;
  uColorB: THREE.Color;
  uColorC: THREE.Color;
  uColorD: THREE.Color;
  uCoral: THREE.Color;
  uCoralAmount: number;
};
