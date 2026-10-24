// ============================================================================
// sky.js — 夜空渐变、背景星与月亮(全部程序化)
// ----------------------------------------------------------------------------
// 世界坐标约定:竖直方向 1.0 = 视口高度(正交相机 top=0.5 / bottom=-0.5),
// 水平方向按宽高比展开(aspect = 宽/高)。屏幕归一化坐标 (nx,ny) 换算:
//   worldX = (nx - 0.5) * aspect,  worldY = 0.5 - ny
// 因此所有视觉比例都能用"画面百分比"直接表达,便于对齐 brief 的构图约束。
//
// 冻结语义:P7 要求暂停时整幅画面静止,所以星星闪烁只依赖传入的 simTime
// (暂停期间 simTime 不前进 → uniform 不变 → 像素不变)。
// ============================================================================

import * as THREE from 'three';

const SKY_VERT = `
varying float vT;   // 0 = 视口底部, 1 = 视口顶部(世界坐标,不受面片缩放影响)
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vT = clamp(wp.y + 0.5, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKY_FRAG = `
varying float vT;
void main() {
  float t = vT;
  // 基础渐变:天顶深蓝黑 → 地平线蓝紫 → 贴地更暗(城市灯光被楼体挡住)
  vec3 base = mix(vec3(0.034, 0.032, 0.078), vec3(0.050, 0.062, 0.150), smoothstep(0.0, 0.52, t));
  base = mix(base, vec3(0.026, 0.034, 0.076), smoothstep(0.55, 0.95, t));
  // 地平线光带:中心落在天际线上方(屏幕 y≈0.67),上下快速衰减
  float band = exp(-pow((t - 0.33) / 0.075, 2.0));
  vec3 col = base + vec3(0.115, 0.105, 0.235) * band;
  // 城市灯光污染:更贴近楼群的一条暖色微光
  col += vec3(0.060, 0.035, 0.030) * exp(-pow((t - 0.225) / 0.075, 2.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

const STAR_VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aPhase;
attribute float aSpeed;
uniform float uTime;
uniform float uPixelScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  float tw = 0.78 + 0.22 * sin(uTime * aSpeed + aPhase);
  vAlpha = aAlpha * tw;
  gl_PointSize = max(1.0, aSize * uPixelScale);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const POINT_FRAG = `
uniform sampler2D uTex;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = texture2D(uTex, gl_PointCoord).a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

/** 夜空:一张铺满视口的渐变面片(不随交互变化)。 */
export function createNightSky(scene) {
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.position.set(0, 0, -8);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  scene.add(mesh);

  function resize(aspect) {
    mesh.scale.set(aspect * 1.12, 1.12, 1); // 多给 6% 余量,避免 resize 时露边
  }
  return { mesh, resize };
}

/** 背景星 + 月亮:星星 >=120 颗,只分布在上半屏(建筑剪影之上)。 */
export function createStars(scene, starTexture, glowTexture) {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelScale: { value: 720 },
      uTex: { value: starTexture },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -900;
  scene.add(points);

  // 月亮:两层柔光(大光晕 + 小核心),静态,不参与闪烁
  const moonGeometry = new THREE.BufferGeometry();
  const moonMaterial = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelScale: { value: 720 },
      uTex: { value: glowTexture },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const moon = new THREE.Points(moonGeometry, moonMaterial);
  moon.frustumCulled = false;
  moon.renderOrder = -899;
  scene.add(moon);

  function build(aspect) {
    const N = 230;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const alpha = new Float32Array(N);
    const phase = new Float32Array(N);
    const speed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // 上半屏 (ny 0.02..0.50 → worldY 0.48..0.00),避开楼顶所在的低空
      const nx = Math.random();
      const ny = 0.02 + Math.random() * 0.47;
      pos[i * 3] = (nx - 0.5) * aspect;
      pos[i * 3 + 1] = 0.5 - ny;
      pos[i * 3 + 2] = 0;
      // 冷白到淡蓝的轻微色温差异
      const warm = Math.random();
      const base = 0.55 + Math.random() * 0.45;
      if (warm < 0.12) {
        col[i * 3] = base;
        col[i * 3 + 1] = base * 0.9;
        col[i * 3 + 2] = base * 0.78;
      } else {
        col[i * 3] = base * (0.86 + Math.random() * 0.1);
        col[i * 3 + 1] = base * (0.9 + Math.random() * 0.08);
        col[i * 3 + 2] = base;
      }
      size[i] = 0.0016 + Math.pow(Math.random(), 2.2) * 0.0038;
      alpha[i] = 0.35 + Math.random() * 0.65;
      phase[i] = Math.random() * Math.PI * 2;
      speed[i] = 0.25 + Math.random() * 1.5;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geometry.attributes.position.needsUpdate = true;

    // 月亮固定在画面右上偏中(归一化 0.80, 0.12)
    const mx = (0.80 - 0.5) * aspect;
    const my = 0.5 - 0.12;
    const mpos = new Float32Array([mx, my, 0, mx, my, 0.001]);
    const mcol = new Float32Array([0.55, 0.6, 0.75, 0.9, 0.92, 1.0]);
    const msize = new Float32Array([0.30, 0.045]);
    const malpha = new Float32Array([0.11, 0.85]);
    const mph = new Float32Array([0, 0]);
    const msp = new Float32Array([0, 0]);
    moonGeometry.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
    moonGeometry.setAttribute('aColor', new THREE.BufferAttribute(mcol, 3));
    moonGeometry.setAttribute('aSize', new THREE.BufferAttribute(msize, 1));
    moonGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(malpha, 1));
    moonGeometry.setAttribute('aPhase', new THREE.BufferAttribute(mph, 1));
    moonGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(msp, 1));
  }

  function update(time, pixelScale) {
    material.uniforms.uTime.value = time;
    material.uniforms.uPixelScale.value = pixelScale;
    moonMaterial.uniforms.uPixelScale.value = pixelScale;
  }

  return { build, update };
}
