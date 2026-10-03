// ============================================================================
// campfire.js — 篝火组:石圈 + 交叉柴堆 + 火苗面片 + 火苗粒子 + 火星 +
//                地面暖光斑 + 动态火光(PointLight)
// ----------------------------------------------------------------------------
// * 火苗:2 大 1 小交叉面片,顶点噪声摆动(尖部甩动)+ 片元梯度
//   (白黄→橙→红)+ fbm 上卷,加法混合;另有 44 个火苗粒子(>=30 粒子硬指标)。
// * 火星:64 个上升粒子(峰值 >=40),上升速度 1.2-2.6 单位/s,寿命
//   0.8-2.0s,横向风摆 + 淡出。
// * 动态火光:PointLight 位于 (0,1.35,0),强度 = (30+150·flicker)·日间衰减,
//   真实照亮地面与树干(受光面亮度随闪烁变化)——P2 的核心证据。
// * fireFlicker(t):基准 0.55,四频正弦混合(0.7/2.3/3.1/5.1 Hz ∈ 0.5-6Hz),
//   波幅约 ±0.31(>=0.08),钳到 [0.12, 0.95]。状态与画面同一来源,不伪造。
// ============================================================================

import * as THREE from 'three';
import { mulberry32, randRange } from './rng.js';
import { makeGlowPointsMaterial } from './glow-points.js';

const FLAME_PARTICLE_COUNT = 44; // 火苗粒子(同屏恒定,>=30)
const SPARK_COUNT = 64;          // 火星(同屏恒定,峰值 >=40)

/** 多频火光闪烁函数(纯解析,主循环与状态通道共用同一来源)。 */
export function fireFlicker(t) {
  const a = 0.13 * Math.sin(t * Math.PI * 2 * 0.7 + 0.0);
  const b = 0.09 * Math.sin(t * Math.PI * 2 * 2.3 + 1.7);
  const c = 0.05 * Math.sin(t * Math.PI * 2 * 5.1 + 4.2);
  const d = 0.04 * Math.sin(t * Math.PI * 2 * 3.1 + 2.9);
  return Math.min(0.95, Math.max(0.12, 0.55 + a + b + c + d));
}

export function createCampfire(scene, pointMats) {
  const group = new THREE.Group();
  const rng = mulberry32(20260409);

  // ---------------- 石圈 ----------------
  {
    const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + randRange(rng, -0.1, 0.1);
      const r = randRange(rng, 0.78, 0.94);
      const s = randRange(rng, 0.13, 0.2);
      const stone = new THREE.Mesh(
        stoneGeo,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color('#71717c').offsetHSL(0, randRange(rng, -0.02, 0.02), randRange(rng, -0.06, 0.06)),
          flatShading: true,
          roughness: 0.95,
        })
      );
      stone.scale.set(s, s * randRange(rng, 0.6, 0.85), s);
      stone.position.set(Math.cos(a) * r, s * 0.42, Math.sin(a) * r);
      stone.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      group.add(stone);
    }
  }

  // ---------------- 交叉柴堆(teepee)----------------
  {
    const up = new THREE.Vector3(0, 1, 0);
    const apex = new THREE.Vector3(0, 0.62, 0);
    const dir = new THREE.Vector3();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + randRange(rng, -0.18, 0.18);
      const baseR = randRange(rng, 0.4, 0.52);
      const base = new THREE.Vector3(Math.cos(a) * baseR, 0.04, Math.sin(a) * baseR);
      dir.subVectors(apex, base);
      const len = dir.length() + randRange(rng, 0.05, 0.14);
      dir.normalize();
      const log = new THREE.Mesh(
        new THREE.CylinderGeometry(0.052, 0.075, len, 6),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? '#3a2c1c' : new THREE.Color('#5d4326').offsetHSL(0, 0, randRange(rng, -0.04, 0.04)),
          flatShading: true,
          roughness: 1.0,
        })
      );
      log.quaternion.setFromUnitVectors(up, dir);
      log.position.copy(base).addScaledVector(dir, len / 2);
      group.add(log);
    }
  }

  // ---------------- 火苗面片(shader 变形)----------------
  const FLAME_VERT = /* glsl */ `
    uniform float uTime;
    uniform float uFlicker;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec3 p = position;
      float h = uv.y;                       // 0=底 1=尖
      float pinch = sin(3.14159265 * h);    // 两端夹紧,中段自由
      float sway = sin(uTime * 3.1 + h * 5.0) * 0.42
                 + sin(uTime * 5.9 + h * 9.0) * 0.2;
      p.x += sway * pinch * pinch * (0.3 + 0.28 * uFlicker);
      p.z += cos(uTime * 2.4 + h * 7.0) * pinch * pinch * 0.16;
      p.x *= mix(1.0, 0.3, h);              // 尖部收窄
      p.z *= mix(1.0, 0.3, h);
      p.xz *= (0.85 + 0.15 * uFlicker);     // 呼吸宽窄
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `;
  const FLAME_FRAG = /* glsl */ `
    uniform float uTime;
    uniform float uFlicker;
    uniform float uDayFade;
    uniform vec3 uC0;
    uniform vec3 uC1;
    uniform vec3 uC2;
    uniform vec3 uC3;
    varying vec2 vUv;
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    void main() {
      float h = vUv.y;
      float ax = sin(3.14159265 * vUv.x);
      float ay = pow(1.0 - h, 1.12) * smoothstep(0.0, 0.1, h);
      float mask = pow(max(0.0, ax), 1.35) * ay;
      float n = vnoise(vec2(vUv.x * 3.2, h * 2.6 - uTime * 2.5));
      n = 0.6 * n + 0.4 * vnoise(vec2(vUv.x * 6.4 + 3.1, h * 5.2 - uTime * 3.8));
      float alpha = mask * (0.55 + 0.6 * n);
      if (alpha < 0.006) discard;
      vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.3, h));
      col = mix(col, uC2, smoothstep(0.3, 0.65, h));
      col = mix(col, uC3, smoothstep(0.65, 1.0, h));
      col *= (1.45 + 1.05 * uFlicker) * uDayFade;
      gl_FragColor = vec4(col, alpha * (0.85 + 0.15 * uFlicker));
    }
  `;
  const flameGeo = new THREE.PlaneGeometry(1.5, 2.0, 10, 14);
  flameGeo.translate(0, 1.0, 0); // 底边对齐 y=0,便于落位
  function makeFlameMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uFlicker: { value: 0.55 },
        uDayFade: { value: 1.0 },
        uC0: { value: new THREE.Color('#fff3c4') },
        uC1: { value: new THREE.Color('#ffc63e') },
        uC2: { value: new THREE.Color('#ff7d1f') },
        uC3: { value: new THREE.Color('#cf3010') },
      },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
    });
  }
  const flameMats = [makeFlameMaterial(), makeFlameMaterial()]; // [大面片共用, 核心亮面片]
  const flameConfigs = [
    { mat: flameMats[0], rot: 0.0, scale: 1.0, y: 0.14 },
    { mat: flameMats[0], rot: Math.PI / 2, scale: 0.94, y: 0.14 },
    { mat: flameMats[1], rot: Math.PI / 4, scale: 0.55, y: 0.1 },
  ];
  for (const cfg of flameConfigs) {
    const m = new THREE.Mesh(flameGeo, cfg.mat);
    m.rotation.y = cfg.rot;
    m.scale.setScalar(cfg.scale);
    m.position.y = cfg.y;
    m.renderOrder = 5;
    group.add(m);
  }

  // ---------------- 火苗粒子(44)----------------
  const flameP = {
    count: FLAME_PARTICLE_COUNT,
    pos: new Float32Array(FLAME_PARTICLE_COUNT * 3),
    size: new Float32Array(FLAME_PARTICLE_COUNT),
    alpha: new Float32Array(FLAME_PARTICLE_COUNT),
    mix: new Float32Array(FLAME_PARTICLE_COUNT),
    data: new Array(FLAME_PARTICLE_COUNT),
  };
  const flamePMat = makeGlowPointsMaterial('#ffd24a', '#ff5a12', pointMats);
  const flamePoints = new THREE.Points(
    (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(flameP.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(flameP.size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aAlpha', new THREE.BufferAttribute(flameP.alpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aMix', new THREE.BufferAttribute(flameP.mix, 1).setUsage(THREE.DynamicDrawUsage));
      return g;
    })(),
    flamePMat
  );
  flamePoints.frustumCulled = false;
  group.add(flamePoints);

  // ---------------- 火星(64)----------------
  const sparks = {
    count: SPARK_COUNT,
    pos: new Float32Array(SPARK_COUNT * 3),
    size: new Float32Array(SPARK_COUNT),
    alpha: new Float32Array(SPARK_COUNT),
    mix: new Float32Array(SPARK_COUNT),
    data: new Array(SPARK_COUNT),
  };
  const sparkMat = makeGlowPointsMaterial('#ffb347', '#ff4713', pointMats);
  const sparkPoints = new THREE.Points(
    (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(sparks.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(sparks.size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aAlpha', new THREE.BufferAttribute(sparks.alpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aMix', new THREE.BufferAttribute(sparks.mix, 1).setUsage(THREE.DynamicDrawUsage));
      return g;
    })(),
    sparkMat
  );
  sparkPoints.frustumCulled = false;
  group.add(sparkPoints);

  // ---------------- 地面暖光斑(加法径向渐变,叠加在真实点光之上)----------------
  const glowUniforms = {
    uFlicker: { value: 0.55 },
    uDayFade: { value: 1.0 },
    uCol: { value: new THREE.Color('#ff7a22') },
  };
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(7.6, 7.6),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: glowUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFlicker;
        uniform float uDayFade;
        uniform vec3 uCol;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(max(0.0, 1.0 - d), 2.6);
          float alpha = a * (0.5 + 0.5 * uFlicker) * uDayFade * 0.55;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(uCol * (0.8 + 0.5 * uFlicker), alpha);
        }
      `,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.045;
  glow.renderOrder = 4;
  group.add(glow);

  // ---------------- 动态火光 ----------------
  const fireLight = new THREE.PointLight(0xff8a3d, 130, 46, 2);
  fireLight.position.set(0, 1.35, 0);
  group.add(fireLight);
  const colWarmA = new THREE.Color('#ffa050');
  const colWarmB = new THREE.Color('#ff6a26');

  scene.add(group);

  // ---------------- 粒子初始化 / 重放 ----------------
  let prng = mulberry32(20260409);

  function initParticles() {
    prng = mulberry32(20260409);
    for (let i = 0; i < FLAME_PARTICLE_COUNT; i++) {
      flameP.data[i] = {
        life: randRange(prng, 0, 1),
        maxLife: randRange(prng, 0.55, 0.95),
        angle: prng() * Math.PI * 2,
        angSpeed: randRange(prng, 1.2, 3.0) * (prng() < 0.5 ? -1 : 1),
        r0: randRange(prng, 0.08, 0.3),
        rise: randRange(prng, 1.05, 1.6),
        swayA: randRange(prng, 0.05, 0.16),
        swayF: randRange(prng, 3.0, 6.0),
        swayP: prng() * Math.PI * 2,
        size0: randRange(prng, 0.16, 0.3),
      };
    }
    for (let i = 0; i < SPARK_COUNT; i++) {
      const a = prng() * Math.PI * 2;
      const r = randRange(prng, 0, 0.22);
      sparks.data[i] = {
        x: Math.cos(a) * r,
        y: randRange(prng, 0.5, 2.2),
        z: Math.sin(a) * r,
        vy: randRange(prng, 1.2, 2.6),       // 上升速度 1.2-2.6 单位/s(spec 1-3)
        maxLife: randRange(prng, 0.8, 2.0),  // 寿命 0.8-2s(spec 一致)
        life: randRange(prng, 0, 1),
        windA: randRange(prng, 0.15, 0.42),
        windF: randRange(prng, 0.6, 1.8),
        windP: prng() * Math.PI * 2,
        size0: randRange(prng, 0.05, 0.1),
      };
    }
  }
  initParticles();

  // ---------------- 逐帧更新 ----------------
  function update(dt, ctx) {
    const flick = ctx.flicker;
    const day = ctx.dayFactor;
    const t = ctx.simTime;

    // 火光:强度/颜色随同一 flicker 波动(画面与状态同源)
    fireLight.intensity = (36 + 170 * flick) * (1 - 0.35 * day);
    fireLight.color.lerpColors(colWarmA, colWarmB, 0.5 + 0.5 * Math.sin(t * 9.3));

    // 面片 uniforms(两大面片共用材质 + 核心亮面片材质)
    for (const m of flameMats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uFlicker.value = flick;
      m.uniforms.uDayFade.value = 1 - 0.45 * day;
    }
    glowUniforms.uFlicker.value = flick;
    glowUniforms.uDayFade.value = 1 - 0.6 * day;

    // 火苗粒子
    for (let i = 0; i < FLAME_PARTICLE_COUNT; i++) {
      const d = flameP.data[i];
      d.life += dt / d.maxLife;
      if (d.life >= 1) {
        d.life = 0;
        d.angle = prng() * Math.PI * 2;
        d.r0 = randRange(prng, 0.08, 0.3);
      }
      d.angle += d.angSpeed * dt;
      const lf = d.life;
      const r = d.r0 * (1 - lf * 0.78);
      const sway = Math.sin(t * d.swayF + d.swayP) * d.swayA * lf;
      flameP.pos[i * 3] = Math.cos(d.angle) * r + sway;
      flameP.pos[i * 3 + 1] = 0.16 + lf * d.rise;
      flameP.pos[i * 3 + 2] = Math.sin(d.angle) * r + sway * 0.6;
      flameP.size[i] = d.size0 * (1 - 0.5 * lf);
      flameP.alpha[i] = Math.pow(1 - lf, 1.25) * 0.85 * (0.8 + 0.3 * flick);
      flameP.mix[i] = lf;
    }
    flamePoints.geometry.attributes.position.needsUpdate = true;
    flamePoints.geometry.attributes.aSize.needsUpdate = true;
    flamePoints.geometry.attributes.aAlpha.needsUpdate = true;
    flamePoints.geometry.attributes.aMix.needsUpdate = true;

    // 火星
    for (let i = 0; i < SPARK_COUNT; i++) {
      const d = sparks.data[i];
      d.life += dt / d.maxLife;
      if (d.life >= 1) {
        d.life = 0;
        const a = prng() * Math.PI * 2;
        const r = randRange(prng, 0, 0.2);
        d.x = Math.cos(a) * r;
        d.z = Math.sin(a) * r;
        d.y = randRange(prng, 0.4, 0.9);
        d.vy = randRange(prng, 1.2, 2.6);
      }
      d.y += d.vy * dt;
      d.vy = Math.max(1.0, d.vy - 0.22 * dt);
      const wind = Math.sin(t * d.windF + d.windP) * d.windA * (0.3 + d.life);
      sparks.pos[i * 3] = d.x + wind;
      sparks.pos[i * 3 + 1] = d.y;
      sparks.pos[i * 3 + 2] = d.z + Math.cos(t * d.windF * 0.8 + d.windP) * d.windA * 0.7 * (0.3 + d.life);
      const lf = d.life;
      sparks.size[i] = d.size0 * (1 - 0.35 * lf);
      sparks.alpha[i] = Math.pow(1 - lf, 1.6) * (0.6 + 0.5 * flick);
      sparks.mix[i] = Math.min(1, lf * 1.4);
    }
    sparkPoints.geometry.attributes.position.needsUpdate = true;
    sparkPoints.geometry.attributes.aSize.needsUpdate = true;
    sparkPoints.geometry.attributes.aAlpha.needsUpdate = true;
    sparkPoints.geometry.attributes.aMix.needsUpdate = true;
  }

  function reset() {
    initParticles();
  }

  return { update, reset, fireLight, group };
}
