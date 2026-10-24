// ============================================================================
// city.js — 程序化城市剪影(楼群 + 暖色亮窗 + 楼顶航空障碍灯)
// ----------------------------------------------------------------------------
// 构图约束(brief §2/§3):
//   * 楼数 >= 24;楼高 = 画面高 8%–45%;楼宽 = 画面宽 1.5%–6%
//   * 剪影贴底(世界 y = -0.5),近黑但与夜空可区分
//   * 亮窗总数 >= 80(暖黄/暖白),楼梯轮廓与窗户全部随机生成
// 全部几何在 regenerate() 内重建 —— reset() 需要"城市重新随机生成但楼数不变"。
// ============================================================================

import * as THREE from 'three';

const WIN_VERT = `
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
  float tw = 0.74 + 0.26 * sin(uTime * aSpeed + aPhase);
  vAlpha = aAlpha * tw;
  gl_PointSize = max(1.0, aSize * uPixelScale);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LIGHT_VERT = `
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
  float pulse = pow(0.5 + 0.5 * sin(uTime * aSpeed + aPhase), 6.0);
  vAlpha = aAlpha * (0.07 + 0.93 * pulse);
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

function makePointMaterial(texture, vertexShader) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelScale: { value: 720 },
      uTex: { value: texture },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createCity(scene, { windowTexture, glowTexture }) {
  const group = new THREE.Group();
  scene.add(group);

  const buildingMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
  });
  const buildingMesh = new THREE.Mesh(new THREE.BufferGeometry(), buildingMaterial);
  buildingMesh.renderOrder = -500;
  buildingMesh.frustumCulled = false;
  group.add(buildingMesh);

  const windowMaterial = makePointMaterial(windowTexture, WIN_VERT);
  const windows = new THREE.Points(new THREE.BufferGeometry(), windowMaterial);
  windows.renderOrder = -450;
  windows.frustumCulled = false;
  group.add(windows);

  const lightMaterial = makePointMaterial(glowTexture, LIGHT_VERT);
  const aviation = new THREE.Points(new THREE.BufferGeometry(), lightMaterial);
  aviation.renderOrder = -440;
  aviation.frustumCulled = false;
  group.add(aviation);

  let buildings = [];
  const baseline = -0.5;
  const colorScratch = new THREE.Color();

  function pushQuad(pos, col, x0, y0, x1, y1, cBot, cTop) {
    // 两个三角形,底边亮、顶边暗,给纯黑剪影一点层次
    const verts = [
      [x0, y0, cBot], [x1, y0, cBot], [x1, y1, cTop],
      [x0, y0, cBot], [x1, y1, cTop], [x0, y1, cTop],
    ];
    for (const [x, y, c] of verts) {
      pos.push(x, y, 0);
      col.push(c[0], c[1], c[2]);
    }
  }

  function regenerate(aspect) {
    buildings = [];
    const halfW = aspect * 0.5;
    const count = 26 + Math.floor(Math.random() * 5); // 26–30 栋

    // 楼宽先按画面宽百分比取,再整体缩放让天际线覆盖整幅宽度
    const widths = [];
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const w = (0.015 + Math.random() * 0.045) * aspect;
      widths.push(w);
      sum += w;
    }
    const scale = (aspect * 1.05) / sum;

    const pos = [];
    const col = [];
    let cursor = -halfW - 0.02 * aspect;
    const tall = [];

    for (let i = 0; i < count; i++) {
      const w = widths[i] * scale;
      const x0 = cursor;
      const x1 = x0 + w;
      cursor = x1 - w * 0.035; // 轻微重叠,避免出现透光裂缝

      let h = 0.12 + Math.pow(Math.random(), 1.55) * 0.28; // 12%–40% 主体
      if (i % 7 === 0) h = 0.37 + Math.random() * 0.08; // 地标高楼 37%–45%
      if (i % 13 === 6) h = 0.08 + Math.random() * 0.02; // 少数矮楼,覆盖 8% 下限
      const top = baseline + h;

      buildings.push({ x0, x1, top, height: h, center: (x0 + x1) / 2 });

      // sRGB 亮度 0.02–0.05:近黑剪影,但保留一点点蓝调,和夜空区分
      colorScratch.setHSL(0.60 + Math.random() * 0.07, 0.35 + Math.random() * 0.3, 0.020 + Math.random() * 0.030, THREE.SRGBColorSpace);
      const r = colorScratch.r;
      const g = colorScratch.g;
      const b = colorScratch.b;
      pushQuad(pos, col, x0, baseline, x1, top,
        [r * 1.45, g * 1.38, b * 1.32],
        [r * 0.68, g * 0.68, b * 0.76]);

      // 楼顶天线剪影,给天际线一些细节
      if (h > 0.22 && Math.random() < 0.65) {
        const ax = (x0 + x1) / 2;
        const aw = 0.0011;
        const ah = 0.012 + Math.random() * 0.028;
        pushQuad(pos, col, ax - aw, top, ax + aw, top + ah,
          [r * 1.2, g * 1.2, b * 1.2],
          [r * 1.2, g * 1.2, b * 1.2]);
      }
      if (h > 0.26) tall.push(buildings[buildings.length - 1]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    buildingMesh.geometry.dispose();
    buildingMesh.geometry = geo;

    // ---- 亮窗:楼面上的小格子;整列偶尔更亮,像有人住 ----
    const wpos = [];
    const wcol = [];
    const wsize = [];
    const walpha = [];
    const wphase = [];
    const wspeed = [];
    let windowCount = 0;

    for (const bld of buildings) {
      const innerX0 = bld.x0 + 0.0045;
      const innerX1 = bld.x1 - 0.0045;
      const topLimit = bld.top - 0.014;
      if (innerX1 <= innerX0 || topLimit <= baseline + 0.02) continue;
      for (let wx = innerX0; wx <= innerX1; wx += 0.0105) {
        const columnBoost = Math.random() < 0.22 ? 0.62 : 0.18;
        for (let wy = baseline + 0.015; wy <= topLimit; wy += 0.0145) {
          if (Math.random() > columnBoost) continue;
          const warm = Math.random() > 0.11;
          const bright = 0.5 + Math.random() * 0.5;
          let cr;
          let cg;
          let cb;
          if (warm) {
            const t = Math.random();
            cr = 1.0 * bright;
            cg = (0.62 + t * 0.26) * bright;
            cb = (0.22 + t * 0.30) * bright;
          } else {
            cr = 0.72 * bright;
            cg = 0.82 * bright;
            cb = 1.0 * bright;
          }
          wpos.push(wx, wy, 0);
          wcol.push(cr, cg, cb);
          wsize.push(0.0042 + Math.random() * 0.0018);
          walpha.push(0.5 + Math.random() * 0.5);
          wphase.push(Math.random() * Math.PI * 2);
          wspeed.push(0.15 + Math.random() * 1.5);
          windowCount += 1;
        }
      }
    }

    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wpos), 3));
    wgeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(wcol), 3));
    wgeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(wsize), 1));
    wgeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(walpha), 1));
    wgeo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(wphase), 1));
    wgeo.setAttribute('aSpeed', new THREE.BufferAttribute(new Float32Array(wspeed), 1));
    windows.geometry.dispose();
    windows.geometry = wgeo;

    // ---- 楼顶红色航空障碍灯(缓慢脉动) ----
    const lpos = [];
    const lcol = [];
    const lsize = [];
    const lalpha = [];
    const lphase = [];
    const lspeed = [];
    const maxLights = Math.min(5, tall.length);
    for (let i = 0; i < maxLights; i++) {
      const bld = tall[Math.floor(Math.random() * tall.length)];
      lpos.push(bld.center, bld.top + 0.004, 0);
      lcol.push(1.0, 0.10, 0.07);
      lsize.push(0.0055 + Math.random() * 0.0025);
      lalpha.push(0.9);
      lphase.push(Math.random() * Math.PI * 2);
      lspeed.push(1.0 + Math.random() * 1.4);
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lpos), 3));
    lgeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(lcol), 3));
    lgeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(lsize), 1));
    lgeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(lalpha), 1));
    lgeo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(lphase), 1));
    lgeo.setAttribute('aSpeed', new THREE.BufferAttribute(new Float32Array(lspeed), 1));
    aviation.geometry.dispose();
    aviation.geometry = lgeo;

    return { buildingCount: buildings.length, windowCount };
  }

  function isInCity(nx, ny, aspect) {
    const wx = (nx - 0.5) * aspect;
    const wy = 0.5 - ny;
    for (const bld of buildings) {
      if (wx >= bld.x0 && wx <= bld.x1 && wy <= bld.top + 0.004) return true;
    }
    return false;
  }

  function update(time, pixelScale) {
    windowMaterial.uniforms.uTime.value = time;
    windowMaterial.uniforms.uPixelScale.value = pixelScale;
    lightMaterial.uniforms.uTime.value = time;
    lightMaterial.uniforms.uPixelScale.value = pixelScale;
  }

  return {
    group,
    regenerate,
    isInCity,
    update,
    get buildingCount() {
      return buildings.length;
    },
  };
}
