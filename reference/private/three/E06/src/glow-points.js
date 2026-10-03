// ============================================================================
// glow-points.js — 通用发光点精灵 shader(火星 / 火苗粒子 / 萤火虫共用)
// ----------------------------------------------------------------------------
// 世界尺寸点精灵:gl_PointSize = aSize * uScale / -mv.z(uScale = 绘制缓冲高
// / (2·tan(fov/2)),由 main 在 resize 时统一注入);片元做径向软圆 + 双色
// 插值 + 加法混合。aAlpha/aMix 逐帧由 CPU 写入(DynamicDrawUsage)。
// ============================================================================

import * as THREE from 'three';

export const GLOW_POINTS_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aMix;
  uniform float uScale;
  varying float vAlpha;
  varying float vMix;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(0.25, -mv.z), 1.0, 90.0);
    gl_Position = projectionMatrix * mv;
    vAlpha = aAlpha;
    vMix = aMix;
  }
`;

export const GLOW_POINTS_FRAG = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying float vAlpha;
  varying float vMix;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 1.7);
    float alpha = a * vAlpha;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(
      mix(uColA, uColB, clamp(vMix, 0.0, 1.0)) * (0.8 + 0.7 * vAlpha),
      alpha
    );
  }
`;

/** 生成一个加法混合的发光点材质;push 进 pointMats 供 main 统一更新 uScale。 */
export function makeGlowPointsMaterial(colA, colB, pointMats) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uScale: { value: 600 },
      uColA: { value: new THREE.Color(colA) },
      uColB: { value: new THREE.Color(colB) },
    },
    vertexShader: GLOW_POINTS_VERT,
    fragmentShader: GLOW_POINTS_FRAG,
  });
  if (pointMats) pointMats.push(mat);
  return mat;
}
