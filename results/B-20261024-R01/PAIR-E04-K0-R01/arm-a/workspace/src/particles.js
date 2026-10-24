// ============================================================================
// particles.js — 统一粒子池(尾迹 / 爆炸 / 余烬 / 闪光)
// ----------------------------------------------------------------------------
// 为什么用 struct-of-arrays + 预分配:自动表演下同屏粒子峰值会到 ~1500,
// 逐帧 new 对象会产生 GC 抖动(brief §6 要求 minFps >= 30 且"不得整帧丢失更新")。
// 更新用"末位填补"压缩存活粒子,死亡即回收,count 就是真实存活数(状态通道同源)。
// 渲染:THREE.Points + 自定义 shader,gl_PointSize 按"画面高度百分比"换算像素,
// 正交相机下与 z 无关,便于用构图百分比直接设计视觉。
// ============================================================================

import * as THREE from 'three';

const MAX = 5200;

const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uPixelScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  gl_PointSize = max(1.0, aSize * uPixelScale);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
uniform sampler2D uTex;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = texture2D(uTex, gl_PointCoord).a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

const FIELDS = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'r', 'g', 'b',
  'life', 'maxLife', 'grav', 'drag',
  'size0', 'size1', 'alpha0', 'kind', 'flickSpeed', 'flickPhase',
];

export class ParticleSystem {
  constructor(scene, glowTexture) {
    this.count = 0;
    this.f = {};
    for (const name of FIELDS) this.f[name] = new Float32Array(MAX);

    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('aColor', this.colorAttr);
    geometry.setAttribute('aSize', this.sizeAttr);
    geometry.setAttribute('aAlpha', this.alphaAttr);
    geometry.setDrawRange(0, 0);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelScale: { value: 720 },
        uTex: { value: glowTexture },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }

  setPixelScale(px) {
    this.material.uniforms.uPixelScale.value = px;
  }

  /**
   * 生成一个粒子。
   * kind: 0=爆炸 1=尾迹 2=余烬 3=闪光/弹头
   */
  spawn(o) {
    if (this.count >= MAX) return;
    const i = this.count;
    this.count += 1;
    const f = this.f;
    f.x[i] = o.x;
    f.y[i] = o.y;
    f.z[i] = o.z || 0;
    f.vx[i] = o.vx || 0;
    f.vy[i] = o.vy || 0;
    f.vz[i] = o.vz || 0;
    const c = o.color || [1, 1, 1];
    f.r[i] = c[0];
    f.g[i] = c[1];
    f.b[i] = c[2];
    f.life[i] = o.life;
    f.maxLife[i] = o.life;
    f.grav[i] = o.gravity || 0;
    f.drag[i] = o.drag || 0;
    f.size0[i] = o.size0;
    f.size1[i] = o.size1 === undefined ? o.size0 : o.size1;
    f.alpha0[i] = o.alpha0 === undefined ? 1 : o.alpha0;
    f.kind[i] = o.kind || 0;
    f.flickSpeed[i] = o.flickSpeed || 0;
    f.flickPhase[i] = o.flickPhase || 0;
  }

  clear() {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.alphaAttr.needsUpdate = true;
  }

  update(dt, time) {
    const f = this.f;
    let n = this.count;
    let i = 0;
    while (i < n) {
      if (f.life[i] <= 0) {
        n -= 1;
        if (i !== n) {
          for (let k = 0; k < FIELDS.length; k++) {
            const arr = f[FIELDS[k]];
            arr[i] = arr[n];
          }
        }
        continue;
      }
      const damp = Math.exp(-f.drag[i] * dt);
      f.vx[i] *= damp;
      f.vy[i] = (f.vy[i] - f.grav[i] * dt) * damp;
      f.vz[i] *= damp;
      f.x[i] += f.vx[i] * dt;
      f.y[i] += f.vy[i] * dt;
      f.z[i] += f.vz[i] * dt;
      f.life[i] -= dt;
      i += 1;
    }
    this.count = n;

    const pos = this.posAttr.array;
    const col = this.colorAttr.array;
    const size = this.sizeAttr.array;
    const alpha = this.alphaAttr.array;

    for (let k = 0; k < n; k++) {
      const age = Math.min(1, 1 - f.life[k] / f.maxLife[k]);
      const kind = f.kind[k];
      pos[k * 3] = f.x[k];
      pos[k * 3 + 1] = f.y[k];
      pos[k * 3 + 2] = f.z[k];
      col[k * 3] = f.r[k];
      col[k * 3 + 1] = f.g[k];
      col[k * 3 + 2] = f.b[k];
      size[k] = f.size0[k] + (f.size1[k] - f.size0[k]) * age;

      let fade;
      if (kind === 0) fade = Math.pow(1 - age, 0.75); // 爆炸保持亮度到中段,尾段淡出
      else if (kind === 1) fade = Math.pow(1 - age, 1.5);
      else if (kind === 2) fade = Math.pow(1 - age, 0.42);
      else fade = Math.pow(1 - age, 1.7);

      let a = f.alpha0[k] * fade;
      if (kind === 2) {
        // 余烬明灭:深暗到高亮的周期闪烁;频率/相位逐粒子随机
        const tw = 0.5 + 0.5 * Math.sin(time * f.flickSpeed[k] + f.flickPhase[k]);
        a *= 0.08 + 0.92 * tw * tw;
      } else if (kind === 1) {
        // 尾迹火星的细碎闪动
        const tw = 0.5 + 0.5 * Math.sin(time * 9.0 + f.flickPhase[k]);
        a *= 0.7 + 0.3 * tw;
      }
      alpha[k] = a > 1 ? 1 : a;
    }

    // 整块上传:容量 5200 的属性每帧不过几十 KB,比维护 updateRange 更稳
    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }
}
