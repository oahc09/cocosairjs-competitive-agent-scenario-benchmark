// ============================================================================
// sky.js — 天穹渐变 / 星空 / 日夜调色板 / 全局光
// ----------------------------------------------------------------------------
// * 天穹:BackSide 球面 ShaderMaterial,顶色→地平线色竖直渐变(uTop/uHorizon
//   每帧按 timeOfDay 插值);夜=深蓝+星点,日=亮蓝→地平线暖白。
// * 星空:900 Points(屏幕空间像素大小,不随距离衰减),闪烁由相位正弦,
//   uNight 随 timeOfDay 淡出(白天不可见)。
// * 调色板:夜/日两端色与光强,applyDay(t) 一次性插值写入所有 uniform/灯。
// * 全局光:HemisphereLight(天光)+ DirectionalLight(夜=月光冷蓝,日=暖阳,
//   同一盏灯随 t 换角色),与场景线性 Fog 联动(fog 色=地平线色,衔接无缝)。
// ============================================================================

import * as THREE from 'three';
import { mulberry32, randRange } from './rng.js';

const STAR_COUNT = 900;

// 夜 / 日 两端调色板(线性空间插值)
const PAL = {
  skyTop: [new THREE.Color('#050812'), new THREE.Color('#2f7ed6')],
  skyHor: [new THREE.Color('#16234c'), new THREE.Color('#f3eedd')],
  skyBottom: [new THREE.Color('#02030a'), new THREE.Color('#a9c0cf')],
  hemiSky: [new THREE.Color('#31427a'), new THREE.Color('#bcd9f5')],
  hemiGround: [new THREE.Color('#141b11'), new THREE.Color('#69784f')],
  hemiInt: [0.62, 1.5],
  sunCol: [new THREE.Color('#93aade'), new THREE.Color('#fff2d2')],
  sunInt: [0.7, 2.6],
};

export function createSky(scene) {
  // ---------------- 天穹 ----------------
  const domeUniforms = {
    uTop: { value: new THREE.Color() },
    uHor: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 18),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: domeUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHor;
        uniform vec3 uBottom;
        varying vec3 vDir;
        void main() {
          float h = normalize(vDir).y;
          vec3 col;
          if (h >= 0.0) {
            // 指数地平线带:紧贴地平线为暖白,向上很快过渡到顶色(亮蓝/深蓝)
            col = mix(uTop, uHor, exp(-h * 16.0));
          } else {
            col = mix(uHor, uBottom, pow(-h, 0.55));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
  );
  dome.renderOrder = -10; // 先画,天穹永远垫底
  scene.add(dome);

  // ---------------- 星空 ----------------
  const starGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(STAR_COUNT * 3);
  const ss = new Float32Array(STAR_COUNT); // 屏幕像素大小
  const sph = new Float32Array(STAR_COUNT); // 闪烁相位
  const stw = new Float32Array(STAR_COUNT); // 闪烁速度
  const smix = new Float32Array(STAR_COUNT); // 色温:0 白 1 暖 2 冷
  {
    const rng = mulberry32(20260401);
    for (let i = 0; i < STAR_COUNT; i++) {
      const y = randRange(rng, 0.04, 0.98); // 只布上半球
      const az = rng() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      sp[i * 3] = Math.cos(az) * rr * 520;
      sp[i * 3 + 1] = y * 520;
      sp[i * 3 + 2] = Math.sin(az) * rr * 520;
      const roll = rng();
      ss[i] = roll < 0.62 ? randRange(rng, 1.0, 1.7) : roll < 0.9 ? randRange(rng, 1.8, 2.6) : randRange(rng, 2.8, 3.8);
      sph[i] = rng() * Math.PI * 2;
      stw[i] = randRange(rng, 0.5, 2.2);
      const cm = rng();
      smix[i] = cm < 0.72 ? 0 : cm < 0.87 ? 1 : 2;
    }
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(sph, 1));
  starGeo.setAttribute('aTw', new THREE.BufferAttribute(stw, 1));
  starGeo.setAttribute('aMix', new THREE.BufferAttribute(smix, 1));
  const starUniforms = {
    uTime: { value: 0 },
    uNight: { value: 1 },
    uPixelRatio: { value: 1 },
  };
  const stars = new THREE.Points(
    starGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: starUniforms,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        attribute float aTw;
        attribute float aMix;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        varying float vMix;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio;
          vAlpha = 0.55 + 0.45 * sin(uTime * aTw + aPhase);
          vMix = aMix;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vAlpha;
        varying float vMix;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          float a = pow(max(0.0, 1.0 - d), 2.0);
          vec3 col = vMix < 0.5 ? vec3(0.92, 0.95, 1.0)
                   : vMix < 1.5 ? vec3(1.0, 0.88, 0.72)
                   : vec3(0.72, 0.84, 1.0);
          float alpha = a * vAlpha * uNight;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col * (0.7 + 0.6 * vAlpha), alpha);
        }
      `,
    })
  );
  scene.add(stars);

  // ---------------- 月亮(运行时生成径向渐变贴图的加法 Sprite,白天淡出)------
  const moon = (() => {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0.0, 'rgba(255,252,235,1)');
    grad.addColorStop(0.22, 'rgba(248,246,225,0.95)');
    grad.addColorStop(0.4, 'rgba(210,220,240,0.32)');
    grad.addColorStop(1.0, 'rgba(180,200,240,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    // 与月光方位一致(仰角 ~48°,方位 128°)
    const elev = THREE.MathUtils.degToRad(48);
    const azim = THREE.MathUtils.degToRad(128);
    spr.position.set(
      Math.cos(elev) * Math.cos(azim) * 540,
      Math.sin(elev) * 540,
      Math.cos(elev) * Math.sin(azim) * 540
    );
    spr.scale.set(44, 44, 1);
    spr.renderOrder = -9;
    scene.add(spr);
    return spr;
  })();

  // ---------------- 全局光 ----------------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(20, 30, 12);
  scene.add(sun);

  const tmpTop = new THREE.Color();
  const tmpHor = new THREE.Color();
  const tmpBottom = new THREE.Color();

  /** 按 timeOfDay∈[0,1] 插值写天穹/灯/雾;simTime 驱动星闪。 */
  function applyDay(t, simTime) {
    const k = THREE.MathUtils.clamp(t, 0, 1);
    tmpTop.lerpColors(PAL.skyTop[0], PAL.skyTop[1], k);
    tmpHor.lerpColors(PAL.skyHor[0], PAL.skyHor[1], k);
    tmpBottom.lerpColors(PAL.skyBottom[0], PAL.skyBottom[1], k);
    domeUniforms.uTop.value.copy(tmpTop);
    domeUniforms.uHor.value.copy(tmpHor);
    domeUniforms.uBottom.value.copy(tmpBottom);
    scene.fog.color.copy(tmpHor); // 雾色=地平线色,地形边缘无缝衔接

    hemi.color.lerpColors(PAL.hemiSky[0], PAL.hemiSky[1], k);
    hemi.groundColor.lerpColors(PAL.hemiGround[0], PAL.hemiGround[1], k);
    hemi.intensity = THREE.MathUtils.lerp(PAL.hemiInt[0], PAL.hemiInt[1], k);

    sun.color.lerpColors(PAL.sunCol[0], PAL.sunCol[1], k);
    sun.intensity = THREE.MathUtils.lerp(PAL.sunInt[0], PAL.sunInt[1], k);
    // 夜=月光高悬冷角,日=太阳升高:仰角 38°→56°,方位固定
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(38, 56, k));
    const azim = THREE.MathUtils.degToRad(128);
    sun.position.set(
      Math.cos(elev) * Math.cos(azim) * 40,
      Math.sin(elev) * 40,
      Math.cos(elev) * Math.sin(azim) * 40
    );

    starUniforms.uTime.value = simTime;
    const nightK = 1 - THREE.MathUtils.smoothstep(k, 0.55, 0.85);
    starUniforms.uNight.value = nightK;
    moon.material.opacity = nightK;
  }

  applyDay(0, 0);

  return {
    applyDay,
    setPixelRatio(pr) {
      starUniforms.uPixelRatio.value = pr;
    },
  };
}
