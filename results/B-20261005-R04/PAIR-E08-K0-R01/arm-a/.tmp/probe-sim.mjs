// probe-sim.mjs — E08 sim 核心的探针确定性回放自检(Node,无浏览器)
// 用法: node probe-sim.mjs
// 复刻 spec.json P1-P8 的动作时序(wait/drag/pointermove/click/ui-reset),
// 以固定 60Hz 步进 sim.update,逐 probe 断言 stateContract 字段。
import { createSim } from '../workspace/src/sim.js';

const DT = 1 / 60;
const sim = createSim();
let perfT = 0;

const results = [];
function check(id, cond, detail) {
  results.push({ id, pass: !!cond, detail });
}

function step(seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    perfT += DT * 1000;
    sim.update(DT);
  }
}
const st = () => sim.state;
const rect = { left: 0, top: 0, width: 1280, height: 720 };

// P1 wait:2500
step(2.5);
{
  const s = st();
  check('P1', s.fishCount >= 80 && s.planktonCount >= 300 && s.boidMode === 'normal' && s.foodActive === false,
    `fish=${s.fishCount} plank=${s.planktonCount} mode=${s.boidMode} food=${s.foodActive} coh=${s.avgCohesion} cen=${JSON.stringify(s.centroid)}`);
}
// P2 wait:2000
step(2.0);
{
  const s = st();
  check('P2', s.boidMode === 'normal' && s.avgCohesion >= 0.45,
    `mode=${s.boidMode} coh=${s.avgCohesion} cen=${JSON.stringify(s.centroid)}`);
}
// P3 drag from (320,360) to (960,360),~30ms/步(与浏览器合成事件节奏一致)
sim.pointerDown(320, 360, perfT);
for (let i = 1; i <= 10; i++) {
  sim.pointerMove(320 + Math.round(640 * i / 10), 360, rect);
  step(0.033);
}
sim.pointerUp(960, 360, perfT, { onUi: false, isCanvas: true, button: 0, rect });
step(1.2);
{
  const s = st();
  check('P3', s.boidMode === 'scatter' && s.avgCohesion < 0.35,
    `mode=${s.boidMode} coh=${s.avgCohesion} scared=${s.scared} cen=${JSON.stringify(s.centroid)}`);
}
// P4 pointermove(20,20) + wait:6000
sim.pointerMove(20, 20, rect);
step(6.0);
{
  const s = st();
  check('P4', s.boidMode === 'normal' && s.avgCohesion >= 0.45,
    `mode=${s.boidMode} coh=${s.avgCohesion} cen=${JSON.stringify(s.centroid)}`);
}
// P5 click (640,360)
sim.pointerDown(640, 360, perfT);
sim.pointerUp(640, 360, perfT, { onUi: false, isCanvas: true, button: 0, rect });
step(0.8);
{
  const s = st();
  check('P5', s.foodActive === true && s.foodPosition !== null,
    `food=${s.foodActive} pos=${JSON.stringify(s.foodPosition)} dFood=${s.avgDistanceToFood}`);
}
// P6 wait:4000
step(4.0);
{
  const s = st();
  check('P6', s.avgDistanceToFood !== null && s.avgDistanceToFood < 6,
    `dFood=${s.avgDistanceToFood} coh=${s.avgCohesion}`);
}
// P7 click ui=reset
sim.reset();
step(2.0);
{
  const s = st();
  check('P7', s.fishCount >= 80 && s.boidMode === 'normal' && s.foodActive === false && s.avgDistanceToFood === null,
    `fish=${s.fishCount} mode=${s.boidMode} food=${s.foodActive} dFood=${s.avgDistanceToFood}`);
}
// P8 wait:1500 + 长稳(再跑 120s,验证无计数漂移/NaN)
step(1.5);
{
  const s = st();
  check('P8', s.fishCount >= 80 && s.planktonCount >= 300,
    `fish=${s.fishCount} plank=${s.planktonCount}`);
}
const fish0 = sim.fishes.map((f) => f.pos.x).join(',');
step(120);
{
  const s = st();
  const fish1 = sim.fishes.map((f) => f.pos.x).join(',');
  const sane = sim.fishes.every((f) => Number.isFinite(f.pos.x + f.pos.y + f.pos.z) && Number.isFinite(f.vel.x + f.vel.y + f.vel.z));
  check('STABLE', sane && s.fishCount === 96 && s.planktonCount === 460 && fish0 !== fish1,
    `finite=${sane} fish=${s.fishCount} plank=${s.planktonCount} moving=${fish0 !== fish1} coh=${s.avgCohesion} mode=${s.boidMode}`);
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.detail}`);
}
console.log(failed === 0 ? 'ALL_PASS' : `FAILED=${failed}`);
process.exit(failed === 0 ? 0 : 1);
