/**
 * Quad geometry helpers.
 *
 * 场景相机沿 -Z 正交取景,所有内容都是 XY 平面上的四边形,
 * 因此粒子贴片不需要每帧求 billboard 基向量 —— 平移/缩放顶点即可。
 *
 * MeshBuilder  : 一次性静态几何(夜空/城市),输出 numbers[] 给 utils.MeshUtils.createMesh
 * QuadField    : 固定容量的动态四边形池(粒子/航空灯),输出预分配 TypedArray 给
 *                utils.MeshUtils.createDynamicMesh + Mesh.updateSubMesh
 */

/** 一个四边形的顶点顺序:左下 → 右下 → 右上 → 左上,索引 (0,1,2)(0,2,3)。 */
export class MeshBuilder {
    constructor() {
        this.positions = [];
        this.uvs = [];
        this.colors = [];
        this.indices = [];
    }

    get vertexCount() {
        return this.positions.length / 3;
    }

    /** color = [r, g, b, a],分量 0..1。 */
    quad(cx, cy, cz, halfW, halfH, color) {
        this.quadGradient(cx, cy, cz, halfW, halfH, color, color, color, color);
    }

    /** 每个角独立颜色,用于天空垂直渐变(逐行插值)。 */
    quadGradient(cx, cy, cz, halfW, halfH, cBL, cBR, cTR, cTL) {
        const base = this.vertexCount;
        this.positions.push(
            cx - halfW, cy - halfH, cz,
            cx + halfW, cy - halfH, cz,
            cx + halfW, cy + halfH, cz,
            cx - halfW, cy + halfH, cz,
        );
        this.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        this.colors.push(
            cBL[0], cBL[1], cBL[2], cBL[3],
            cBR[0], cBR[1], cBR[2], cBR[3],
            cTR[0], cTR[1], cTR[2], cTR[3],
            cTL[0], cTL[1], cTL[2], cTL[3],
        );
        this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    geometry() {
        return {
            positions: this.positions,
            uvs: this.uvs,
            colors: this.colors,
            indices: this.indices,
        };
    }
}

/**
 * 固定容量动态四边形场。每一帧 begin() → add() → end(),
 * end() 只清空上一帧多出来的尾部,避免整池重写。
 */
export class QuadField {
    constructor(capacity) {
        this.capacity = capacity;
        this.positions = new Float32Array(capacity * 4 * 3);
        this.uvs = new Float32Array(capacity * 4 * 2);
        this.colors = new Float32Array(capacity * 4 * 4);
        this.indices = new Uint16Array(capacity * 6);
        for (let i = 0; i < capacity; i += 1) {
            // 初值把顶点铺开:首帧 mesh 包围盒即覆盖全屏,避免动态网格被视锥剔除。
            const col = i % 8;
            const row = Math.floor(i / 8) % 8;
            const x = -9 + (col / 7) * 18;
            const y = -6 + (row / 7) * 12;
            const p = i * 12;
            for (let v = 0; v < 4; v += 1) {
                this.positions[p + v * 3] = x;
                this.positions[p + v * 3 + 1] = y;
                this.positions[p + v * 3 + 2] = 1.5;
            }
            const u = i * 8;
            this.uvs[u] = 0; this.uvs[u + 1] = 0;
            this.uvs[u + 2] = 1; this.uvs[u + 3] = 0;
            this.uvs[u + 4] = 1; this.uvs[u + 5] = 1;
            this.uvs[u + 6] = 0; this.uvs[u + 7] = 1;
            const base = i * 4;
            this.indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i * 6);
        }
        // 颜色初值全 0:初始化用的铺开顶点在首帧不可见。
        this.count = 0;
        this._live = 0;
    }

    begin() {
        this.count = 0;
    }

    add(x, y, z, halfW, halfH, color) {
        if (this.count >= this.capacity) return;
        const i = this.count;
        const p = i * 12;
        const pos = this.positions;
        pos[p] = x - halfW; pos[p + 1] = y - halfH; pos[p + 2] = z;
        pos[p + 3] = x + halfW; pos[p + 4] = y - halfH; pos[p + 5] = z;
        pos[p + 6] = x + halfW; pos[p + 7] = y + halfH; pos[p + 8] = z;
        pos[p + 9] = x - halfW; pos[p + 10] = y + halfH; pos[p + 11] = z;
        const c = i * 16;
        const col = this.colors;
        for (let v = 0; v < 4; v += 1) {
            col[c + v * 4] = color[0];
            col[c + v * 4 + 1] = color[1];
            col[c + v * 4 + 2] = color[2];
            col[c + v * 4 + 3] = color[3];
        }
        this.count = i + 1;
    }

    /**
     * 预分配几何视图(初始化动态网格与每帧 updateSubMesh 共用同一批 TypedArray)。
     * 动态网格只认 indices16 / indices32(createDynamicMesh 与 updateSubMesh 的实现如此),
     * 传 `indices` 会被静默忽略 → 没有索引缓冲,三角形会跨四边形错误连线。
     */
    geometry() {
        return {
            positions: this.positions,
            uvs: this.uvs,
            colors: this.colors,
            indices16: this.indices,
            // 动态网格包围盒:整块几何始终覆盖视口,避免被视锥剔除。
            minPos: { x: -10, y: -6, z: 0 },
            maxPos: { x: 10, y: 6, z: 2 },
        };
    }

    end() {
        const pos = this.positions;
        const col = this.colors;
        for (let i = this.count; i < this._live; i += 1) {
            const p = i * 12;
            for (let k = 0; k < 12; k += 1) pos[p + k] = 0;
            const c = i * 16;
            for (let k = 0; k < 16; k += 1) col[c + k] = 0;
        }
        this._live = this.count;
        return this.geometry();
    }
}
