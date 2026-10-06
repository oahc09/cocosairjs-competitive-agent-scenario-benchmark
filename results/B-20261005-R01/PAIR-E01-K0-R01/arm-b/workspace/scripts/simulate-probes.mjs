// 探针状态断言的桌面仿真:以与 src/main.js 完全相同的控制律(dt=1/60 步进)验证 P3/P4/P7 的
// 时序语义与断言裕度。不打开浏览器、不占用 browserAttempt 预算。
const DT = 1 / 60;
const DIST0 = 120, DIST_MIN = 40, DIST_MAX = 400;
const DIST_GLIDE = 28, DIST_RESET_RATE = 6.0;
const PAR_MAX = 0.06, PAR_SMOOTH = 6.0;
const ROT_SPEED = 0.05;

const st = { dist: DIST0, targetDist: DIST0, resetGlide: false, parX: 0, targetParX: 0, parY: 0, targetParY: 0, phase: 0 };

function step(n = 1) {
    for (let i = 0; i < n; i++) {
        // 距离(与 main.js 一致)
        const gap = st.targetDist - st.dist;
        if (Math.abs(gap) < (st.resetGlide ? 0.3 : 0.5)) {
            st.dist = st.targetDist;
            st.resetGlide = false;
        } else if (st.resetGlide) {
            st.dist += gap * (1 - Math.exp(-DIST_RESET_RATE * DT));
        } else {
            st.dist += Math.sign(gap) * Math.min(Math.abs(gap), DIST_GLIDE * DT);
        }
        // 视差
        const k = 1 - Math.exp(-PAR_SMOOTH * DT);
        st.parX += (st.targetParX - st.parX) * k;
        st.parY += (st.targetParY - st.parY) * k;
        // 相位
        st.phase += ROT_SPEED * DT;
    }
}
const t = (s) => Math.round(s / DT);

// ---- P4 语义A:action → wait 500ms → before → wait 300ms → after ----
st.dist = DIST0; st.targetDist = DIST0; st.resetGlide = false;
st.targetDist = Math.max(DIST_MIN, Math.min(DIST_MAX, DIST0 + (-600) * 0.06)); // wheel
step(t(0.5)); const p4beforeA = st.dist;
step(t(0.3)); const p4afterA = st.dist;
console.log(`P4-A: before=${p4beforeA.toFixed(2)} after=${p4afterA.toFixed(2)} pass=${p4afterA < p4beforeA - 5} (margin ${(p4beforeA - 5 - p4afterA).toFixed(2)})`);

// ---- P4 语义B:action → before 立即 → wait 300ms → after(容错口径) ----
st.dist = DIST0; st.targetDist = DIST0; st.resetGlide = false;
st.targetDist = DIST0 - 36;
step(1); const p4beforeB = st.dist;
step(t(0.3)); const p4afterB = st.dist;
console.log(`P4-B: before=${p4beforeB.toFixed(2)} after=${p4afterB.toFixed(2)} pass=${p4afterB < p4beforeB - 5}`);

// ---- P4 窗口抖动容限:[550,850] 与 [450,750] ----
for (const [a, b] of [[0.55, 0.85], [0.45, 0.75], [0.6, 0.8]]) {
    st.dist = DIST0; st.targetDist = DIST0; st.resetGlide = false;
    st.targetDist = DIST0 - 36;
    step(t(a)); const bf = st.dist;
    step(t(b - a)); const af = st.dist;
    console.log(`P4 jitter [${a},${b}]: before=${bf.toFixed(2)} after=${af.toFixed(2)} pass=${af < bf - 5} (margin ${(bf - 5 - af).toFixed(2)})`);
}

// ---- P7:reset 前距离已收敛到 84(P4 后历经 P5/P6 等待) ----
step(t(3)); // 继续收敛到 84
console.log(`P7 前置: dist=${st.dist.toFixed(2)}`);
st.targetParX = 0.0216; st.targetParY = 0; // 假设指针停在按钮处产生的残余视差
step(t(0.05)); // harness 归位指针到中心
st.targetParX = 0; st.targetParY = 0;
// click reset
st.epoch = (st.epoch || 0) + 1; st.phase = 0; st.targetDist = DIST0; st.resetGlide = true; st.targetParX = 0; st.targetParY = 0;
step(t(0.8));
console.log(`P7: epoch=${1} dist=${st.dist.toFixed(2)} in[115,125]=${st.dist >= 115 && st.dist <= 125} parX=${st.parX.toFixed(5)} |parX|<0.01=${Math.abs(st.parX) < 0.01} phase=${st.phase.toFixed(4)} <0.1=${st.phase < 0.1}`);

// ---- P7 极端:reset 前距离=400(范围上限) ----
st.dist = 400; st.targetDist = 400; st.resetGlide = false; st.phase = 3.0;
st.targetDist = DIST0; st.resetGlide = true;
step(t(0.95));
console.log(`P7 极端(400→120): dist=${st.dist.toFixed(2)} in[115,125]=${st.dist >= 115 && st.dist <= 125}`);

// ---- P3:指针 0.5→0.68,语义A(action→wait400→before→wait600→after) ----
st.parX = 0; st.targetParX = 0;
st.targetParX = 0.06 * (0.68 - 0.5) * 2;
step(t(0.4)); const p3before = st.parX;
step(t(0.6)); const p3after = st.parX;
console.log(`P3: before=${p3before.toFixed(5)} after=${p3after.toFixed(5)} differ=${p3after !== p3before} (Δ=${(p3after - p3before).toExponential(2)})`);

// ---- P2:相位 2s 增量 ----
const ph0 = st.phase;
step(t(2));
console.log(`P2: phase delta over 2s = ${(st.phase - ph0).toFixed(4)} > 0.001 = ${st.phase - ph0 > 0.001}`);

// ---- P6:fps 状态由渲染帧计;此处仅确认旋转速度在 spec 区间 ----
console.log(`ROT_SPEED=${ROT_SPEED} rad/s ∈ [0.02,0.1]: ${ROT_SPEED >= 0.02 && ROT_SPEED <= 0.1}`);
