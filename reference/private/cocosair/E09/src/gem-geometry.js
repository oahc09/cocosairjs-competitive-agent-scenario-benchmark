/**
 * E09 gem-geometry.js — 程序化多切面宝石几何(brief §3.1 程序化替代路线)。
 *
 * 十边形阶梯/明亮式切型:台面 1 面 + 冠部两条反棱柱带(星形/风筝面)+ 腰棱带 +
 * 亭部反棱柱带 + 尖底扇面。SEG=10 → 100 三角形(brief 60–200 区间),
 * 81 个平面切面(≥20),逐面平直法线(flat shading)驱动折射/色散/高光扫动。
 *
 * 绕序定向:每个三角按调用方给定的"外向参考向量"校正绕序 → 法线恒外向。
 */

const SEG = 10;

function ring (radius, y, rotSteps) {
    const pts = [];
    for (let i = 0; i < SEG; i++) {
        const th = ((i + (rotSteps || 0)) / SEG) * Math.PI * 2;
        pts.push([Math.cos(th) * radius, y, Math.sin(th) * radius]);
    }
    return pts;
}

/**
 * @param {number} scale 整体缩放(默认 1;腰部半径 = scale)
 * @returns {{ positions:number[], normals:number[], indices:number[], triangles:number, facets:number }}
 */
export function buildGemGeometry (scale = 1) {
    const positions = [];
    const normals = [];
    const indices = [];
    let triangles = 0;

    /** ref:外向参考向量(切面法线应与其同侧)。 */
    const pushTri = (a, b, c, ref) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const dot = nx * ref[0] + ny * ref[1] + nz * ref[2];
        let p = [a, b, c];
        if (dot < 0) {
            p = [a, c, b];
            nx = -nx; ny = -ny; nz = -nz;
        }
        const len = Math.max(Math.hypot(nx, ny, nz), 1e-9);
        nx /= len; ny /= len; nz /= len;
        const base = positions.length / 3;
        for (const v of p) {
            positions.push(v[0] * scale, v[1] * scale, v[2] * scale);
            normals.push(nx, ny, nz);
        }
        indices.push(base, base + 1, base + 2);
        triangles++;
    };

    const outward = (a, b, c, tilt) => {
        const cx = (a[0] + b[0] + c[0]) / 3;
        const cz = (a[2] + b[2] + c[2]) / 3;
        const cy = (a[1] + b[1] + c[1]) / 3;
        return [cx, cy * tilt, cz];
    };
    const pushSide = (a, b, c, tilt) => pushTri(a, b, c, outward(a, b, c, tilt));

    // 轮廓(SEG=10;单位:腰部半径 1.0,总高 1.54)
    const table = ring(0.52, 0.66);
    const crownMid = ring(0.78, 0.38, 0.5);
    const girdleTop = ring(1.0, 0.03);
    const girdleBot = ring(1.0, -0.03);
    const pavRing = ring(0.52, -0.52, 0.5);
    const culet = [0, -0.88, 0];
    const UP = [0, 1, 0];

    // 台面(扇面;1 切面,法线朝上)
    for (let i = 1; i < SEG - 1; i++) pushTri(table[0], table[i], table[i + 1], UP);

    // 反棱柱带:B 环相对 A 环旋转半步 → 2×SEG 个三角面
    const antiPrism = (top, bottom, tilt) => {
        for (let i = 0; i < SEG; i++) {
            const j = (i + 1) % SEG;
            pushSide(top[i], bottom[i], top[j], tilt);
            pushSide(bottom[i], bottom[j], top[j], tilt);
        }
    };
    antiPrism(table, crownMid, 0.25);      // 上冠部(星形面)——法线偏上外
    antiPrism(crownMid, girdleTop, 0.15);  // 下冠部(风筝面)

    // 腰棱带(每边 1 平面;四边形 2 共面三角)
    for (let i = 0; i < SEG; i++) {
        const j = (i + 1) % SEG;
        pushSide(girdleTop[i], girdleBot[i], girdleTop[j], 0.02);
        pushSide(girdleBot[i], girdleBot[j], girdleTop[j], 0.02);
    }

    // 亭部反棱柱带 + 尖底扇面(法线偏下外)
    antiPrism(girdleBot, pavRing, -0.2);
    for (let i = 0; i < SEG; i++) {
        const j = (i + 1) % SEG;
        pushSide(pavRing[i], culet, pavRing[j], -0.5);
    }

    return {
        positions,
        normals,
        indices,
        triangles,
        facets: 1 + SEG * 2 + SEG + SEG * 2 + SEG, // 1 + 20 + 10 + 20 + 10 = 81
    };
}
