// ============================================================================
// orrery.js — E03 太阳系仪:天体系统 + 确定性轨道模拟
// ----------------------------------------------------------------------------
// 组成:中心恒星(自发光球 + 双层加色光晕)、8 颗行星(分层公转 + 自转)、
// 3 颗卫星(父子层级,随行星公转)、土星半透明环(倾斜环面)、
// 小行星带(1600 个实例化碎石,开普勒式分层角速度)、背景星(着色器闪烁)。
// 全部程序化生成(参数化几何 + canvas 程序纹理),无任何外部资产。
//
// 轨道运动完全由传入的模拟时间确定性驱动:
//   第 k 颗行星轨道角 = k·45° + 2π·simTime / 周期
// 角度连续累计不取模;reset 期间 main.js 传入"回卷"中的等效时间,全部天体
// 平滑倒退回初始相位(reset 走 0.85s 恢复过渡,时钟随后从 0 恢复推进)。
// ============================================================================

import * as THREE from 'three';

const TAU = Math.PI * 2;

// ---------- 行星冻结参数表(轨道半径升序;周期单调递增) ----------------------
// period:公转周期(模拟秒),最内 230(允许 120–240),最外 3400(允许 1600–4000)。
// spin:自转周期(模拟秒)。radius:可视半径(保证初始视角屏幕投影 >= 8 CSS px)。
export const PLANETS = [
  { name: 'mercury', type: '岩质 Rocky', radius: 1.75, orbitRadius: 11, period: 230, spin: 120, kind: 'rocky',
    base: '#b3a08c', accent: '#7d6c58' },
  { name: 'venus', type: '岩质 Rocky', radius: 2.05, orbitRadius: 16, period: 400, spin: 200, kind: 'rocky',
    base: '#e6c894', accent: '#c2a066' },
  { name: 'earth', type: '类地 Terrestrial', radius: 2.15, orbitRadius: 22, period: 560, spin: 42, kind: 'earth',
    moons: [{ name: 'luna', radius: 0.62, orbitRadius: 3.9, period: 18 }] },
  { name: 'mars', type: '岩质 Rocky', radius: 1.85, orbitRadius: 28, period: 810, spin: 44, kind: 'rocky',
    base: '#c9663f', accent: '#8c3f26' },
  { name: 'jupiter', type: '气态巨行星 Gas Giant', radius: 3.6, orbitRadius: 38, period: 1500, spin: 17, kind: 'banded',
    bands: ['#d9b98c', '#b78c5e', '#e8d4ae', '#a3734f', '#ddc199', '#bb8f61', '#e3cda4', '#ad7d55'],
    moons: [
      { name: 'io', radius: 0.55, orbitRadius: 5.6, period: 12 },
      { name: 'europa', radius: 0.5, orbitRadius: 7.4, period: 24 },
    ] },
  { name: 'saturn', type: '气态巨行星 Gas Giant', radius: 3.1, orbitRadius: 50, period: 2100, spin: 15, kind: 'banded',
    bands: ['#ead8ab', '#cfb47c', '#f2e4bc', '#bfa068', '#e5cf9d', '#d3b984'],
    ring: { innerScale: 1.5, outerScale: 2.35, tiltDeg: 26.7 } },
  { name: 'uranus', type: '冰巨 Ice Giant', radius: 2.5, orbitRadius: 62, period: 2800, spin: 30, kind: 'ice',
    base: '#9edbe0', accent: '#6fbfc9' },
  { name: 'neptune', type: '冰巨 Ice Giant', radius: 2.4, orbitRadius: 74, period: 3400, spin: 26, kind: 'ice',
    base: '#4e79d4', accent: '#2f56b5' },
];

export const MOON_COUNT = PLANETS.reduce((n, p) => n + (p.moons ? p.moons.length : 0), 0);
export const RINGED_PLANET_COUNT = PLANETS.filter((p) => p.ring).length;
export const ASTEROID_COUNT = 1600;          // >= 500 个独立小天体(状态值 = 实例数)
export const BELT_INNER = 31.5;              // 位于 mars(28)与 jupiter(38)之间
export const BELT_OUTER = 36.5;
export const STAR_COUNT = 750;

/** 第 index 颗行星在 simTime 时刻的轨道角(弧度,连续累计不取模)。 */
export function orbitAngleOf(cfg, index, simTime) {
  return (index * Math.PI) / 4 + (TAU * simTime) / cfg.period;
}

// ---------- 确定性随机(程序化生成可复现) ------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 程序纹理(canvas 绘制,无外部资源) --------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 不规则斑块(大陆/陨石坑/云团)。 */
function blob(g, x, y, rx, ry, rand, color, alpha) {
  g.fillStyle = color;
  g.globalAlpha = alpha;
  for (let i = 0; i < 7; i++) {
    const ox = x + (rand() - 0.5) * rx * 1.4;
    const oy = y + (rand() - 0.5) * ry * 1.4;
    g.beginPath();
    g.ellipse(ox, oy, rx * (0.35 + rand() * 0.5), ry * (0.35 + rand() * 0.5), rand() * Math.PI, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

function rockyTexture(cfg, rand) {
  const [c, g] = makeCanvas(256, 128);
  g.fillStyle = cfg.base;
  g.fillRect(0, 0, 256, 128);
  // 明暗纬度带 + 陨石坑斑点
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i % 2 ? cfg.accent : cfg.base;
    g.globalAlpha = 0.16;
    g.fillRect(0, i * 26 + rand() * 6, 256, 14 + rand() * 8);
  }
  g.globalAlpha = 1;
  for (let i = 0; i < 46; i++) {
    blob(g, rand() * 256, 12 + rand() * 104, 2 + rand() * 7, 2 + rand() * 5, rand,
      rand() < 0.5 ? cfg.accent : '#ffffff', 0.1 + rand() * 0.22);
  }
  return toTexture(c);
}

function earthTexture(rand) {
  const [c, g] = makeCanvas(256, 128);
  g.fillStyle = '#255fc0';
  g.fillRect(0, 0, 256, 128);
  // 海洋深浅
  for (let i = 0; i < 10; i++) blob(g, rand() * 256, rand() * 128, 24, 12, rand, '#1c4da6', 0.35);
  // 大陆
  const greens = ['#3f9d5f', '#5aa855', '#8fae5a', '#35854f'];
  for (let i = 0; i < 22; i++) {
    blob(g, rand() * 256, 22 + rand() * 84, 5 + rand() * 15, 4 + rand() * 9, rand, greens[i % 4], 0.85);
  }
  // 云带
  for (let i = 0; i < 20; i++) blob(g, rand() * 256, rand() * 128, 8 + rand() * 16, 2 + rand() * 3, rand, '#ffffff', 0.24);
  // 极冠
  g.fillStyle = 'rgba(238,248,255,0.92)';
  g.fillRect(0, 0, 256, 7);
  g.fillRect(0, 121, 256, 7);
  return toTexture(c);
}

function bandedTexture(cfg, rand) {
  const [c, g] = makeCanvas(256, 128);
  const bands = cfg.bands;
  // 水平条纹 + 正弦扰动,气态巨行星的条带感
  for (let y = 0; y < 128; y++) {
    const t = y / 128;
    const idx = Math.floor((t * bands.length + Math.sin(t * 21) * 0.22) % bands.length + bands.length) % bands.length;
    g.fillStyle = bands[idx];
    g.fillRect(0, y, 256, 1);
  }
  // 涡斑(类大红斑)
  blob(g, 60 + rand() * 130, 62 + (rand() - 0.5) * 40, 10, 5, rand, cfg.bands[cfg.bands.length - 1], 0.5);
  // 细颗粒
  for (let i = 0; i < 600; i++) {
    g.fillStyle = rand() < 0.5 ? '#ffffff' : '#000000';
    g.globalAlpha = 0.05;
    g.fillRect(rand() * 256, rand() * 128, 2, 1);
  }
  g.globalAlpha = 1;
  return toTexture(c);
}

function iceTexture(cfg, rand) {
  const [c, g] = makeCanvas(256, 128);
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, cfg.accent);
  grad.addColorStop(0.5, cfg.base);
  grad.addColorStop(1, cfg.accent);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.05 + rand() * 0.07;
    g.fillRect(0, i * 16 + rand() * 6, 256, 3 + rand() * 6);
  }
  g.globalAlpha = 1;
  return toTexture(c);
}

function sunTexture(rand) {
  const [c, g] = makeCanvas(256, 128);
  g.fillStyle = '#fff3cd';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 90; i++) {
    blob(g, rand() * 256, rand() * 128, 3 + rand() * 10, 3 + rand() * 8, rand,
      rand() < 0.55 ? '#ffdf8e' : '#ffc964', 0.3 + rand() * 0.4);
  }
  return toTexture(c);
}

/** 恒星光晕:径向渐变(加色混合用)。 */
function glowTexture(inner, outer) {
  const [c, g] = makeCanvas(256, 256);
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.25, outer);
  grad.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return toTexture(c);
}

/** 土星环纹理:方形画布上画同心环带(RingGeometry 为平面 UV,直接对齐)。 */
function ringTexture(cfg, rand) {
  const size = 512;
  const [c, g] = makeCanvas(size, size);
  const cx = size / 2;
  const rIn = (cfg.innerScale / cfg.outerScale) * (size / 2 - 2);
  const rOut = size / 2 - 2;
  for (let r = rIn; r <= rOut; r += 0.75) {
    const t = (r - rIn) / (rOut - rIn); // 0=内缘 1=外缘
    // 环带亮度轮廓 + 卡西尼缝(约 0.62–0.72)
    let a = 0.25 + 0.6 * Math.abs(Math.sin(t * 26 + Math.sin(t * 7) * 2));
    if (t < 0.06) a *= t / 0.06;
    if (t > 0.94) a *= (1 - t) / 0.06;
    if (t > 0.62 && t < 0.72) a *= 0.18;
    if (t > 0.35 && t < 0.4) a *= 0.55;
    const shade = 0.82 + 0.18 * Math.sin(t * 40 + rand() * 0.4);
    const col = Math.round(216 * shade);
    g.strokeStyle = `rgba(${col},${Math.round(196 * shade)},${Math.round(150 * shade)},${a.toFixed(3)})`;
    g.lineWidth = 1.1;
    g.beginPath();
    g.arc(cx, cx, r, 0, TAU);
    g.stroke();
  }
  return toTexture(c);
}

function planetTexture(cfg, rand) {
  if (cfg.kind === 'earth') return earthTexture(rand);
  if (cfg.kind === 'banded') return bandedTexture(cfg, rand);
  if (cfg.kind === 'ice') return iceTexture(cfg, rand);
  return rockyTexture(cfg, rand);
}

// ---------- 星空着色器(逐星相位闪烁) ----------------------------------------
const STAR_VERT = `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  varying float vPhase;
  varying vec3 vColor;
  void main() {
    vPhase = aPhase;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (691.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const STAR_FRAG = `
  uniform float uTime;
  varying float vPhase;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float mask = smoothstep(0.5, 0.1, d);
    float tw = 0.62 + 0.38 * sin(uTime * 1.7 + vPhase);
    gl_FragColor = vec4(vColor, mask * tw);
  }`;

// ============================================================================
// Orrery — 场景构建 + 每帧更新 + 屏幕投影
// ============================================================================
export class Orrery {
  constructor(scene) {
    this.scene = scene;
    this.rand = mulberry32(20261002);
    this.bodies = [];
    this._buildLights();
    this._buildStars();
    this._buildSun();
    this._buildOrbitLines();
    this._buildPlanets();
    this._buildBelt();
    this._buildSelectionRing();
  }

  _buildLights() {
    // 恒星点光源(衰减略缓于物理值,保证外行星可见但不失“来自太阳”的方向感)
    this.sunLight = new THREE.PointLight(0xffe2b8, 95, 0, 1.2);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x7f8fb5, 0.5));
    const fill = new THREE.DirectionalLight(0x9db6ff, 0.35);
    fill.position.set(40, 80, 140);
    this.scene.add(fill);
  }

  _buildStars() {
    const rand = this.rand;
    const pos = new Float32Array(STAR_COUNT * 3);
    const size = new Float32Array(STAR_COUNT);
    const phase = new Float32Array(STAR_COUNT);
    const col = new Float32Array(STAR_COUNT * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < STAR_COUNT; i++) {
      // 65% 均匀球壳 + 35% 向一条“银河带”聚拢
      if (rand() < 0.65) {
        const u = rand() * 2 - 1;
        const th = rand() * TAU;
        const s = Math.sqrt(1 - u * u);
        v.set(s * Math.cos(th), u, s * Math.sin(th));
      } else {
        v.set(rand() * 2 - 1, (rand() - 0.5) * 0.34, rand() * 2 - 1).normalize();
      }
      v.multiplyScalar(640 + rand() * 190);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = 1.1 + rand() * rand() * 3.4;
      phase[i] = rand() * TAU;
      const warm = rand();
      const b = 0.75 + rand() * 0.25;
      col.set([b, b * (0.86 + warm * 0.12), b * (0.7 + warm * 0.3)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.scene.add(this.stars);
  }

  _buildSun() {
    const rand = this.rand;
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(6, 48, 24),
      new THREE.MeshBasicMaterial({ map: sunTexture(rand) })
    );
    this.scene.add(this.sunMesh);
    const mkGlow = (tex, scale, opacity) => {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      s.scale.set(scale, scale, 1);
      this.scene.add(s);
      return s;
    };
    this.glowTexA = glowTexture('rgba(255,246,214,0.95)', 'rgba(255,196,96,0.42)');
    this.glowTexB = glowTexture('rgba(255,238,190,1.0)', 'rgba(255,170,60,0.30)');
    this.glowInner = mkGlow(this.glowTexA, 17, 0.95);
    this.glowOuter = mkGlow(this.glowTexB, 36, 0.85);
  }

  _buildOrbitLines() {
    this.orbitLines = new THREE.Group();
    for (const p of PLANETS) {
      const N = 160;
      const pts = new Float32Array((N + 1) * 3);
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * TAU;
        pts.set([Math.cos(a) * p.orbitRadius, 0, Math.sin(a) * p.orbitRadius], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0x939db8, transparent: true, opacity: 0.3 })
      );
      this.orbitLines.add(line);
    }
    this.scene.add(this.orbitLines);
  }

  _buildPlanets() {
    const rand = this.rand;
    const moonMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc9, roughness: 1, metalness: 0 });
    for (const cfg of PLANETS) {
      const group = new THREE.Group();       // 行星系统锚点:位于轨道位置
      const tilt = new THREE.Group();        // 轴倾角(环与行星一起倾斜)
      if (cfg.ring) tilt.rotation.z = THREE.MathUtils.degToRad(cfg.ring.tiltDeg);
      else tilt.rotation.z = (rand() - 0.5) * 0.5;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.radius, 40, 22),
        new THREE.MeshStandardMaterial({ map: planetTexture(cfg, rand), roughness: cfg.kind === 'earth' ? 0.62 : 0.88, metalness: 0.04 })
      );
      tilt.add(mesh);

      if (cfg.ring) {
        const rTex = ringTexture(cfg.ring, rand);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(cfg.radius * cfg.ring.innerScale, cfg.radius * cfg.ring.outerScale, 96, 1),
          new THREE.MeshBasicMaterial({ map: rTex, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        tilt.add(ring);
      }
      group.add(tilt);

      const moons = [];
      if (cfg.moons) {
        for (const m of cfg.moons) {
          const orbitPlane = new THREE.Group();
          orbitPlane.rotation.x = (rand() - 0.5) * 0.35; // 轨道面微倾
          const spinner = new THREE.Group();
          const mm = new THREE.Mesh(new THREE.SphereGeometry(m.radius, 20, 12), moonMat);
          mm.position.x = m.orbitRadius;
          spinner.add(mm);
          orbitPlane.add(spinner);
          group.add(orbitPlane);
          moons.push({ cfg: m, spinner, phase: rand() * TAU });
        }
      }
      this.scene.add(group);
      this.bodies.push({ cfg, group, mesh, moons });
    }
    this.bodiesByName = new Map(this.bodies.map((b) => [b.cfg.name, b]));
  }

  _buildBelt() {
    const rand = this.rand;
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 });
    this.belt = new THREE.InstancedMesh(geo, mat, ASTEROID_COUNT);
    this.belt.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    this.beltData = { r: [], a0: [], omega: [], y0: [], wob: [], mats: [] };
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      const r = BELT_INNER + rand() * (BELT_OUTER - BELT_INNER);
      // 开普勒式分层:周期 ∝ r^1.5(锚定 neptune=3400 @ r74),带内再 ±8% 抖动
      const T = 3400 * Math.pow(r / 74, 1.5) * (0.92 + rand() * 0.16);
      this.beltData.r.push(r);
      this.beltData.a0.push(rand() * TAU);
      this.beltData.omega.push(TAU / T);
      this.beltData.y0.push((rand() - 0.5) * 1.8);
      this.beltData.wob.push(rand() * TAU);
      e.set(rand() * TAU, rand() * TAU, rand() * TAU);
      q.setFromEuler(e);
      const sc = 0.45 + rand() * 0.95;
      s.set(sc * (0.7 + rand() * 0.6), sc * (0.7 + rand() * 0.6), sc * (0.7 + rand() * 0.6));
      m.compose(p.set(0, 0, 0), q, s);
      this.beltData.mats.push(m.clone());
      color.setHSL(0.075 + rand() * 0.02, 0.24 + rand() * 0.1, 0.3 + rand() * 0.22);
      this.belt.setColorAt(i, color);
    }
    if (this.belt.instanceColor) this.belt.instanceColor.needsUpdate = true;
    this.scene.add(this.belt);
  }

  _buildSelectionRing() {
    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(1.32, 1.58, 56, 1),
      new THREE.MeshBasicMaterial({ color: 0x6cf3ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    this.selRing.visible = false;
    this.scene.add(this.selRing);
  }

  /** 选中某行星(高亮圈挂到其系统锚点);null 取消。 */
  setSelected(name) {
    if (this._selAttachedTo) {
      this._selAttachedTo.remove(this.selRing);
      this._selAttachedTo = null;
    }
    this.selRing.visible = false;
    if (!name) return;
    const body = this.bodiesByName.get(name);
    if (!body) return;
    const base = body.cfg.radius * 1.12;
    this.selRing.scale.setScalar(base);
    this.selRing.userData.baseScale = base;
    body.group.add(this.selRing);
    this._selAttachedTo = body.group;
    this.selRing.visible = true;
  }

  /** 每帧推进:所有位置由 simTime 确定性计算(非增量积分,reset 天然一致)。 */
  update(simTime, wallTime, camera) {
    // 恒星:自转(表面米粒组织可见移动)+ 光晕呼吸
    this.sunMesh.rotation.y = (TAU * simTime) / 95;
    const pulse = Math.sin(wallTime * 1.9);
    const outer = 36 * (1 + 0.045 * pulse);
    this.glowOuter.scale.set(outer, outer, 1);
    this.glowOuter.material.opacity = 0.82 + 0.12 * pulse;
    this.glowInner.material.opacity = 0.92 + 0.08 * Math.sin(wallTime * 1.9 + 1.3);

    // 行星公转 + 自转;卫星随行星(父子层级)
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const a = orbitAngleOf(b.cfg, i, simTime);
      b.group.position.set(Math.cos(a) * b.cfg.orbitRadius, 0, Math.sin(a) * b.cfg.orbitRadius);
      b.mesh.rotation.y = (TAU * simTime) / b.cfg.spin;
      for (const mo of b.moons) {
        mo.spinner.rotation.y = mo.phase + (TAU * simTime) / mo.cfg.period;
      }
    }

    // 小行星带:直接写实例矩阵的平移分量(旋转/缩放建带时已烘焙)
    const arr = this.belt.instanceMatrix.array;
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      const a = this.beltData.a0[i] + this.beltData.omega[i] * simTime;
      const src = this.beltData.mats[i].elements;
      const o = i * 16;
      arr[o + 12] = Math.cos(a) * this.beltData.r[i];
      arr[o + 13] = this.beltData.y0[i] + Math.sin(a * 3 + this.beltData.wob[i]) * 0.45;
      arr[o + 14] = Math.sin(a) * this.beltData.r[i];
      arr[o + 15] = src[15];
    }
    this.belt.instanceMatrix.needsUpdate = true;

    // 星星闪烁
    this.starMat.uniforms.uTime.value = wallTime;

    // 选中高亮圈:始终面向相机 + 呼吸脉冲
    if (this.selRing.visible) {
      this.selRing.quaternion.copy(camera.quaternion);
      const k = 1 + 0.055 * Math.sin(wallTime * 5.0);
      this.selRing.scale.setScalar(this.selRing.userData.baseScale * k);
      this.selRing.material.opacity = 0.5 + 0.45 * (0.5 + 0.5 * Math.sin(wallTime * 5.0));
    }
  }

  /** 各行星屏幕投影(CSS 像素;screenRadius 即点击判定半径,>= 8px)。 */
  screenData(camera, w, h) {
    const v = new THREE.Vector3();
    const halfH = h / 2;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const out = [];
    for (const b of this.bodies) {
      v.copy(b.group.position);
      const dist = v.distanceTo(camera.position);
      v.project(camera);
      const projR = (b.cfg.radius / dist) * (halfH / tanHalf);
      out.push({
        name: b.cfg.name,
        x: (v.x + 1) * 0.5 * w,
        y: (1 - v.y) * 0.5 * h,
        screenRadius: Math.max(projR * 1.35, 10),
      });
    }
    return out;
  }
}
