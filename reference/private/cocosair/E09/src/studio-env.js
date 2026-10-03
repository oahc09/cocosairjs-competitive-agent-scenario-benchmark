/**
 * E09 studio-env.js — 程序化珠宝摄影棚 cubemap(brief §5:允许自制环境贴图)。
 *
 * 六面 256×256 RGBA:暗色竖直渐变 + 柔亮"柔光箱"矩形(摄影棚条灯)。
 * 用途:scene.globals.skybox.envmap(IBL 环境反射/环境光)+ 可见背景。
 * 面序按 TextureCube.fromTexture2DArray([front, back, left, right, top, bottom])。
 */

const SIZE = 256;

function faceData (painter) {
    const data = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const [r, g, b] = painter(x / (SIZE - 1), y / (SIZE - 1)); // u,v ∈ [0,1]
            const i = (y * SIZE + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
    }
    return data;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 暗棚竖直渐变底色:顶部 #171a22 → 底部 #07080c */
function studioBase (u, v, topBoost = 1) {
    const t = 1 - v; // v=0 顶部
    const r = (7 + t * 10 * topBoost) / 255;
    const g = (8 + t * 12 * topBoost) / 255;
    const b = (11 + t * 17 * topBoost) / 255;
    return [r, g, b];
}

/** 柔亮矩形(柔光箱):中心 (cu,cv),半宽/半高 hw/hh,亮度 L(线性),色温偏色 tint */
function softbox (u, v, cu, cv, hw, hh, L, tint = [1, 1, 1]) {
    const dx = (u - cu) / hw;
    const dy = (v - cv) / hh;
    const d2 = dx * dx + dy * dy;
    const fall = Math.exp(-d2 * 2.2); // 柔和衰减
    return [L * fall * tint[0], L * fall * tint[1], L * fall * tint[2]];
}

const FACE_PAINTERS = {
    // back(-Z,宝石正后方:反射主体——两支竖条灯)
    back (u, v) {
        let c = studioBase(u, v, 1.15);
        const s1 = softbox(u, v, 0.32, 0.38, 0.075, 0.34, 0.95);
        const s2 = softbox(u, v, 0.70, 0.36, 0.055, 0.30, 0.65);
        return [
            clamp01(c[0] + s1[0] + s2[0]),
            clamp01(c[1] + s1[1] + s2[1]),
            clamp01(c[2] + s1[2] + s2[2]),
        ];
    },
    // left(-X:侧逆光柔箱)
    left (u, v) {
        const c = studioBase(u, v, 1.0);
        const s = softbox(u, v, 0.5, 0.34, 0.16, 0.42, 0.55, [0.92, 0.97, 1.05]);
        return [
            clamp01(c[0] + s[0]),
            clamp01(c[1] + s[1]),
            clamp01(c[2] + s[2]),
        ];
    },
    // right(+X:键光柔箱,最亮)
    right (u, v) {
        const c = studioBase(u, v, 1.05);
        const s = softbox(u, v, 0.46, 0.4, 0.13, 0.46, 0.85, [1.04, 1.0, 0.94]);
        return [
            clamp01(c[0] + s[0]),
            clamp01(c[1] + s[1]),
            clamp01(c[2] + s[2]),
        ];
    },
    // front(+Z,相机身后:最暗,仅微渐变)
    front (u, v) {
        return studioBase(u, v, 0.7);
    },
    // top(+Y:顶部大柔光)
    top (u, v) {
        const c = studioBase(u, v, 1.3);
        const s = softbox(u, v, 0.5, 0.5, 0.26, 0.26, 0.75);
        return [
            clamp01(c[0] + s[0]),
            clamp01(c[1] + s[1]),
            clamp01(c[2] + s[2]),
        ];
    },
    // bottom(-Y:暗地板色)
    bottom (u, v) {
        const c = studioBase(u, v, 0.25);
        const s = softbox(u, v, 0.5, 0.5, 0.1, 0.1, 0.10);
        return [
            clamp01(c[0] + s[0]),
            clamp01(c[1] + s[1]),
            clamp01(c[2] + s[2]),
        ];
    },
};

/** 构建六面像素(fromTexture2DArray 面序:front, back, left, right, top, bottom)。 */
export function buildEnvFacePixels () {
    return {
        front: faceData(FACE_PAINTERS.front),
        back: faceData(FACE_PAINTERS.back),
        left: faceData(FACE_PAINTERS.left),
        right: faceData(FACE_PAINTERS.right),
        top: faceData(FACE_PAINTERS.top),
        bottom: faceData(FACE_PAINTERS.bottom),
    };
}
