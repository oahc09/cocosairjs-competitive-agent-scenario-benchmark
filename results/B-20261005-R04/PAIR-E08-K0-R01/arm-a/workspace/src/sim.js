// ============================================================================
// E08 模拟核心(纯逻辑,无 DOM)— Deep Sea Fish School simulation core
// ----------------------------------------------------------------------------
// 把 boids/惊散/投喂/统计全部状态与动力学放在本模块,便于:
//   * main.js 只做渲染与输入转发(相机也由本模块提供,保证判定与画面同源);
//   * Node 侧可确定性回放探针序列,做与浏览器无关的动力学自检。
// 所有指针判定均基于真实几何距离(鱼到指针射线/子步射线的 3D 距离)。
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 常量配置
// ---------------------------------------------------------------------------
export const FISH_COUNT = 96;       // spec: >= 80,建议 80-120
export const PLANKTON_COUNT = 460;  // spec: >= 300,建议 300-600(双层:280+180)
export const FOOD_PIECES = 5;       // 每次投喂 1-5 粒
export const FOOD_LIFETIME = 8.0;   // 食物最长存在(s)
export const BITE_INTERVAL = 1.5;   // 进食限速:相邻两粒被吃最小间隔(s)
export const BITE_RADIUS = 0.55;    // 鱼到食物粒的进食距离

export const SCATTER_RADIUS = 4.2;  // 惊散判定:鱼到指针射线的 3D 距离(brief 建议 2.5,取略宽保证整群可触发)
export const SCATTER_HOLD = 2.0;    // 最后一次触发后 scatter 保持时长(s)(P3 断言在拖拽后 1.2s)
export const FEAR_DECAY = 2.4;      // fear 从 1 衰减到 0 的时长(s)

// 鱼群活动水域(相机 fov55 @ z=24:半高约 12.5、半宽约 22,全部在取景框内)
// y/z 留足纵向空间:惊散是绕指针射线的径向炸开,必须给 ±y/±z 足够行程
const SOFT = { x: 15.5, yTop: 9.0, yBot: -9.0, zFront: 3.2, zBack: -4.8 };
const HARD = { x: 16.4, yTop: 9.8, yBot: -9.8, zFront: 4.0, zBack: -5.5 };

// boids 参数
const NEIGH_R = 4.4, NEIGH_R2 = NEIGH_R * NEIGH_R;
const SEP_R = 1.05, SEP_R2 = SEP_R * SEP_R;
const W_COH = 1.15, W_ALI = 1.5, W_SEP = 2.6, W_WANDER = 0.3, W_HOME = 0.6;
const W_FOOD = 10.0;
const MAX_FORCE = 16.0;
const V_MIN = 1.5, V_MAX = 4.6;
const FLEE_ACCEL = 60.0, V_MAX_FEAR = 16.0;
const FLEE_KICK = 8.5;      // 触发瞬间速度冲量
const PANIC_JITTER = 1.6;   // 恐慌方向的球形随机扰动强度(个体逃向差异化,整群全域炸开)

const SCHOOL_CENTER = new THREE.Vector3(0, 0.6, 0);

function randomInSphere(r) {
  const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  while (v.lengthSq() > 1 || v.lengthSq() < 1e-4) v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  return v.multiplyScalar(r);
}

export function createSim(opts = {}) {
  // 判定相机与渲染相机同源(main.js 直接用它渲染)
  const camera = new THREE.PerspectiveCamera(55, opts.aspect || (1280 / 720), 0.1, 200);
  camera.position.set(0, 0.8, 24);
  camera.lookAt(0, 0.6, 0);

  // --- 鱼群状态(无渲染数据;网格同步在 main 侧) ---
  const fishes = [];
  {
    const dir0 = new THREE.Vector3(0.92, 0.05, 0.16).normalize();
    for (let i = 0; i < FISH_COUNT; i++) {
      const pos = SCHOOL_CENTER.clone().add(randomInSphere(2.6));
      const vel = dir0.clone().multiplyScalar(1.6).add(randomInSphere(0.5));
      fishes.push({
        pos, vel,
        acc: new THREE.Vector3(),
        fear: 0,
        fleeFrom: new THREE.Vector3(),
        panicDir: new THREE.Vector3(0, 1, 0),
        wanderT: Math.random() * Math.PI * 2,
        wanderAxis: randomInSphere(1).normalize(),
        initPos: pos.clone(),
        initVel: vel.clone(),
      });
    }
  }

  // --- 悬浮颗粒(双层;位置由 sim 计算,main 只上传缓冲) ---
  const planktonLayers = [];
  {
    const layerDefs = [
      { count: 280, size: 0.13, opacity: 0.5 },
      { count: 180, size: 0.22, opacity: 0.35 },
    ];
    for (const ld of layerDefs) {
      const base = new Float32Array(ld.count * 3);
      const cur = new Float32Array(ld.count * 3);
      const phase = new Float32Array(ld.count);
      for (let i = 0; i < ld.count; i++) {
        base[i * 3] = (Math.random() * 2 - 1) * 17;
        base[i * 3 + 1] = -7 + Math.random() * 16;
        base[i * 3 + 2] = -10 + Math.random() * 18;
        phase[i] = Math.random() * Math.PI * 2;
      }
      cur.set(base);
      planktonLayers.push({ base, cur, phase, count: ld.count, size: ld.size, opacity: ld.opacity });
    }
  }

  // --- 食物 ---
  const food = {
    active: false,
    pieces: [], // { pos: Vector3, eaten: bool, bob }
    centroid: new THREE.Vector3(),
    spawnT: 0,
    lastBiteT: -Infinity,
  };

  function clearFood() {
    food.pieces = [];
    food.active = false;
  }

  function spawnFood(worldPos) {
    clearFood();
    for (let i = 0; i < FOOD_PIECES; i++) {
      const p = worldPos.clone().add(randomInSphere(0.35));
      food.pieces.push({ pos: p, eaten: false, bob: Math.random() * Math.PI * 2 });
    }
    food.centroid.copy(worldPos);
    food.active = true;
    food.spawnT = nowSec;
    food.lastBiteT = -Infinity;
  }

  // --- 指针状态 ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointerRay = new THREE.Ray();
  let pointerActive = false;
  const curNdc = new THREE.Vector2();
  const lastNdc = new THREE.Vector2();
  let haveNdc = false;
  let sweepDirty = false;
  const down = { x: 0, y: 0, t: 0 };
  const feedW = new THREE.Vector3();
  const pointerW = new THREE.Vector3();

  let lastScatterT = -Infinity;
  let boidMode = 'normal';
  let maxFear = 0;
  let nowSec = 0;

  function rectFor(rect) {
    return rect || opts.rect || { left: 0, top: 0, width: 1280, height: 720 };
  }

  function pointerToWorld(clientX, clientY, out, rect) {
    const r = rectFor(rect);
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    curNdc.copy(ndc);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    const t = d.z !== 0 ? -o.z / d.z : 24;
    if (t > 0) out.copy(o).addScaledVector(d, t);
    else out.copy(o).addScaledVector(d, 24);
    pointerRay.copy(raycaster.ray);
    pointerActive = true;
  }

  function scareFish(f, point) {
    f.fear = 1;
    f.fleeFrom.copy(point);
    // 个体恐慌方向:远离射线为主 + 球形随机扰动,在触发时刻固化(每条鱼逃向差异化,
    // 整群呈球形炸开,不因指针扫掠几何而整体流向某一边界)
    kickV.subVectors(f.pos, point);
    if (kickV.lengthSq() < 1e-6) kickV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    kickV.normalize();
    f.panicDir.copy(kickV).add(randomInSphere(PANIC_JITTER)).normalize();
    f.vel.addScaledVector(f.panicDir, FLEE_KICK + Math.random() * 1.5);
    lastScatterT = nowSec;
  }

  // 沿一条射线做惊散判定:恐惧源 = 射线上离鱼最近的点(逃逸方向垂直射线径向)
  function scareAlongRay(ray) {
    for (const f of fishes) {
      tmpV.copy(f.pos).sub(ray.origin);
      const t = Math.max(0, tmpV.dot(ray.direction));
      closestP.copy(ray.origin).addScaledVector(ray.direction, t);
      if (f.pos.distanceToSquared(closestP) < R_SCATTER2) scareFish(f, closestP);
    }
  }

  function processSweep() {
    if (!sweepDirty || !pointerActive) { sweepDirty = false; return; }
    sweepDirty = false;
    scareAlongRay(pointerRay); // hover:当前位置射线
    if (!haveNdc) {
      lastNdc.copy(curNdc);
      haveNdc = true;
      return;
    }
    const dx = curNdc.x - lastNdc.x, dy = curNdc.y - lastNdc.y;
    const dScreen = Math.hypot(dx, dy);
    if (dScreen > 0.02) {
      const steps = Math.min(40, Math.max(1, Math.ceil(dScreen / 0.04)));
      for (let s = 1; s <= steps; s++) {
        const a = s / steps;
        ndc.set(lastNdc.x + dx * a, lastNdc.y + dy * a);
        raycaster.setFromCamera(ndc, camera);
        scareAlongRay(raycaster.ray);
      }
    }
    lastNdc.copy(curNdc);
  }

  // --- boids 主更新 ---
  const tmpC = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpS = new THREE.Vector3();
  const tmpV = new THREE.Vector3(), kickV = new THREE.Vector3(), closestP = new THREE.Vector3();
  const R_SCATTER2 = SCATTER_RADIUS * SCATTER_RADIUS;

  function updateBoids(dt) {
    const n = fishes.length;
    const foodPull = food.active ? Math.min(1, (nowSec - food.spawnT) / 0.6) : 0;
    maxFear = 0;
    for (let i = 0; i < n; i++) {
      const f = fishes[i];
      f.acc.set(0, 0, 0);
      tmpC.set(0, 0, 0); tmpA.set(0, 0, 0); tmpS.set(0, 0, 0);
      let ci = 0, ai = 0, si = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = fishes[j];
        const d2 = f.pos.distanceToSquared(o.pos);
        if (d2 < NEIGH_R2) {
          tmpC.add(o.pos); ci++;
          tmpA.add(o.vel); ai++;
          if (d2 < SEP_R2 && d2 > 1e-8) {
            tmpV.subVectors(f.pos, o.pos).multiplyScalar(1 / Math.sqrt(d2));
            tmpS.add(tmpV); si++;
          }
        }
      }
      // 恐慌系数:恐惧时聚群/对齐/归家力失效(炸开),平静时恢复
      const panic = 1 - Math.min(1, f.fear * 1.2);
      if (ci > 0) {
        tmpV.copy(tmpC).multiplyScalar(1 / ci).sub(f.pos).multiplyScalar(W_COH * panic);
        f.acc.add(tmpV);
      }
      if (ai > 0) {
        tmpV.copy(tmpA).multiplyScalar(1 / ai).sub(f.vel).multiplyScalar(W_ALI * panic);
        f.acc.add(tmpV);
      }
      if (si > 0) f.acc.addScaledVector(tmpS, W_SEP);

      // 归家:弱牵引使鱼群质心保持在水域中部(取景框安全 + 交互平面可达)
      tmpV.subVectors(SCHOOL_CENTER, f.pos).multiplyScalar(W_HOME * panic);
      f.acc.add(tmpV);

      // 漫游(缓慢转向噪声;有食物时抑制)
      f.wanderT += dt * 0.6;
      tmpV.copy(f.wanderAxis).multiplyScalar(Math.sin(f.wanderT) * (food.active ? 0.08 : 1) * W_WANDER);
      f.acc.add(tmpV);

      // 食物吸引
      if (food.active && foodPull > 0) {
        tmpV.subVectors(food.centroid, f.pos);
        const d = tmpV.length();
        if (d > 0.7) f.acc.addScaledVector(tmpV.normalize(), W_FOOD * foodPull);
      }

      // 惊散逃逸(fear 驱动,沿个体恐慌方向持续加速)
      if (f.fear > 0.02) {
        f.acc.addScaledVector(f.panicDir, FLEE_ACCEL * f.fear);
        f.fear = Math.max(0, f.fear - dt / FEAR_DECAY);
      }
      if (f.fear > maxFear) maxFear = f.fear;

      // 软边界回推
      const p = f.pos;
      if (p.x > SOFT.x) f.acc.x -= (p.x - SOFT.x) * 3.0;
      else if (p.x < -SOFT.x) f.acc.x -= (p.x + SOFT.x) * 3.0;
      if (p.y > SOFT.yTop) f.acc.y -= (p.y - SOFT.yTop) * 3.0;
      else if (p.y < SOFT.yBot) f.acc.y += (SOFT.yBot - p.y) * 3.0;
      if (p.z > SOFT.zFront) f.acc.z -= (p.z - SOFT.zFront) * 3.0;
      else if (p.z < SOFT.zBack) f.acc.z += (SOFT.zBack - p.z) * 3.0;

      // 力限幅(恐惧时放宽)
      const fmax = MAX_FORCE + FLEE_ACCEL * f.fear;
      if (f.acc.lengthSq() > fmax * fmax) f.acc.setLength(fmax);

      // 积分 + 速度限幅
      f.vel.addScaledVector(f.acc, dt);
      const vMin = f.fear > 0.5 ? 4.5 : V_MIN;
      const vMax = V_MAX + (V_MAX_FEAR - V_MAX) * f.fear;
      const sp = f.vel.length();
      if (sp > vMax) f.vel.multiplyScalar(vMax / sp);
      else if (sp < vMin && sp > 1e-6) f.vel.multiplyScalar(vMin / sp);
      f.pos.addScaledVector(f.vel, dt);

      // 硬边界钳制(保证永不游出取景框)
      if (p.x > HARD.x) { p.x = HARD.x; f.vel.x = -Math.abs(f.vel.x); }
      else if (p.x < -HARD.x) { p.x = -HARD.x; f.vel.x = Math.abs(f.vel.x); }
      if (p.y > HARD.yTop) { p.y = HARD.yTop; f.vel.y = -Math.abs(f.vel.y); }
      else if (p.y < HARD.yBot) { p.y = HARD.yBot; f.vel.y = Math.abs(f.vel.y); }
      if (p.z > HARD.zFront) { p.z = HARD.zFront; f.vel.z = -Math.abs(f.vel.z); }
      else if (p.z < HARD.zBack) { p.z = HARD.zBack; f.vel.z = Math.abs(f.vel.z); }
    }

    // 模式判定:真实触发(仍有鱼在恐惧)或保持窗口内
    boidMode = (maxFear > 0.35 || (nowSec - lastScatterT) < SCATTER_HOLD) ? 'scatter' : 'normal';
  }

  function updateFood(dt) {
    if (!food.active) return;
    let cx = 0, cy = 0, cz = 0, alive = 0;
    for (const p of food.pieces) {
      if (p.eaten) continue;
      p.bob += dt * 2.4;
      p.pos.y += Math.sin(p.bob) * 0.0015;
      cx += p.pos.x; cy += p.pos.y; cz += p.pos.z; alive++;
    }
    if (alive > 0) food.centroid.set(cx / alive, cy / alive, cz / alive);

    // 进食:任一鱼贴近未吃完粒,且全局限速到点 → 吃掉一粒
    if (nowSec - food.lastBiteT >= BITE_INTERVAL) {
      outer:
      for (const p of food.pieces) {
        if (p.eaten) continue;
        const r2 = BITE_RADIUS * BITE_RADIUS;
        for (const f of fishes) {
          if (f.pos.distanceToSquared(p.pos) < r2) {
            p.eaten = true;
            food.lastBiteT = nowSec;
            break outer;
          }
        }
      }
    }

    let remaining = 0;
    for (const p of food.pieces) if (!p.eaten) remaining++;
    if (remaining === 0 || nowSec - food.spawnT >= FOOD_LIFETIME) clearFood();
  }

  // --- 统计 ---
  let avgCohesion = 0;
  let avgDistanceToFood = null;
  let scaredCount = 0;
  const centroid = new THREE.Vector3();

  function updateStats() {
    centroid.set(0, 0, 0);
    for (const f of fishes) centroid.add(f.pos);
    centroid.multiplyScalar(1 / fishes.length);
    let sum = 0;
    scaredCount = 0;
    for (const f of fishes) {
      sum += f.pos.distanceTo(centroid);
      if (f.fear > 0.35) scaredCount++;
    }
    avgCohesion = 1 - Math.min(1, (sum / fishes.length) / 10);
    if (food.active) {
      let s = 0;
      for (const f of fishes) s += f.pos.distanceTo(food.centroid);
      avgDistanceToFood = s / fishes.length;
    } else {
      avgDistanceToFood = null;
    }
  }

  function updatePlankton(dt) {
    void dt;
    const t = nowSec;
    for (const layer of planktonLayers) {
      const arr = layer.cur;
      for (let i = 0; i < layer.count; i++) {
        const ph = layer.phase[i];
        arr[i * 3] = layer.base[i * 3] + Math.sin(t * 0.11 + ph) * 0.9;
        arr[i * 3 + 1] = layer.base[i * 3 + 1] + Math.sin(t * 0.07 + ph * 1.3) * 0.6;
        arr[i * 3 + 2] = layer.base[i * 3 + 2] + Math.cos(t * 0.09 + ph * 0.7) * 0.9;
      }
    }
  }

  // --- reset:恢复初始分布、清食物、回 normal;不刷新页面 ---
  function doReset() {
    for (const f of fishes) {
      f.pos.copy(f.initPos);
      f.vel.copy(f.initVel);
      f.fear = 0;
      f.acc.set(0, 0, 0);
    }
    clearFood();
    lastScatterT = -Infinity;
    boidMode = 'normal';
    avgDistanceToFood = null;
  }

  // --- 对外 API ---
  function pointerMove(clientX, clientY, rect) {
    pointerToWorld(clientX, clientY, pointerW, rect);
    sweepDirty = true;
  }

  function pointerDown(clientX, clientY, perfT, rect) {
    down.x = clientX; down.y = clientY; down.t = perfT;
    // 按下位置即指针轨迹起点:首次 move 的扫掠从按下点开始(单步跳变拖拽不漏检)
    pointerToWorld(clientX, clientY, pointerW, rect);
    lastNdc.copy(curNdc);
    haveNdc = true;
  }

  // meta: { onUi, isCanvas, button, rect } — UI 控件上的指针事件不投喂
  function pointerUp(clientX, clientY, perfT, meta = {}) {
    const dtms = perfT - down.t;
    const moved = Math.hypot(clientX - down.x, clientY - down.y);
    if (!meta.onUi && meta.isCanvas && dtms < 450 && moved < 8 && (meta.button || 0) === 0) {
      pointerToWorld(clientX, clientY, feedW, meta.rect);
      spawnFood(feedW);
    }
  }

  function update(dt) {
    nowSec += dt;
    processSweep();
    updateBoids(dt);
    updateFood(dt);
    updateStats();
    updatePlankton(dt);
  }

  const state = {
    get fishCount() { return fishes.length; },
    get planktonCount() { return PLANKTON_COUNT; },
    get boidMode() { return boidMode; },
    get foodActive() { return food.active; },
    get foodPosition() {
      return food.active
        ? { x: +food.centroid.x.toFixed(3), y: +food.centroid.y.toFixed(3), z: +food.centroid.z.toFixed(3) }
        : null;
    },
    get avgCohesion() { return +avgCohesion.toFixed(3); },
    get avgDistanceToFood() { return avgDistanceToFood === null ? null : +avgDistanceToFood.toFixed(3); },
    get centroid() { return { x: +centroid.x.toFixed(2), y: +centroid.y.toFixed(2), z: +centroid.z.toFixed(2) }; },
    get scared() { return scaredCount; },
    get now() { return nowSec; },
  };

  return {
    camera, fishes, food, planktonLayers,
    state,
    update,
    reset: doReset,
    pointerMove, pointerDown, pointerUp,
  };
}
