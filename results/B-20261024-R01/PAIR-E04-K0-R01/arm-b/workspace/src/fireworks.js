/**
 * 烟花粒子时间线 —— 全部粒子都是相机朝向的四边形,由 QuadField 写进同一个动态网格,
 * 因此整场烟花只有 1 个 draw call(加性混合由材质实例的管线状态覆盖完成)。
 *
 * 生命周期:rocket(上升尾迹)→ burst(球状爆炸)→ ember(长寿命余烬)。
 * update(dt) 只在时间线运行时被调用;暂停时调用方直接跳过,所以状态天然冻结。
 */

export const THEMES = [
    { name: 'gold', rgb: [1.0, 0.78, 0.30] },
    { name: 'magenta', rgb: [1.0, 0.35, 0.72] },
    { name: 'cyan', rgb: [0.35, 0.86, 1.0] },
    { name: 'green', rgb: [0.42, 1.0, 0.58] },
    { name: 'violet', rgb: [0.72, 0.52, 1.0] },
    { name: 'amber', rgb: [1.0, 0.62, 0.26] },
];

const GROUND_Y = -4.7;

function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
}

export class Fireworks {
    constructor(rand, capacity = 4096) {
        this.rand = rand;
        this.capacity = capacity;
        this.parts = [];
        this.rockets = [];
        this.time = 0;
    }

    reset() {
        this.parts.length = 0;
        this.rockets.length = 0;
    }

    get alive() {
        return this.parts.length;
    }

    launch(targetX, targetY, theme) {
        const r = this.rand;
        const dist = Math.max(0.5, targetY - GROUND_Y);
        this.rockets.push({
            targetX,
            targetY,
            startY: GROUND_Y,
            x: targetX,
            y: GROUND_Y,
            jitter: (r() - 0.5) * 0.5,
            t: 0,
            dur: clamp(0.62 + dist / 15, 0.65, 1.45),
            theme,
            spawnAcc: 0,
            tick: 0,
        });
    }

    _trail(rocket) {
        const r = this.rand;
        const hot = r() < 0.35;
        this._spawn({
            kind: 'trail',
            x: rocket.x + (r() - 0.5) * 0.10,
            y: rocket.y - r() * 0.16,
            z: 1.4 + r() * 0.3,
            vx: (r() - 0.5) * 0.5,
            vy: -0.15 + r() * 0.45,
            life: 0.3 + r() * 0.35,
            size: 0.05 + r() * 0.07,
            color: hot ? [1.0, 0.95, 0.82] : [1.0, 0.80, 0.45],
            alpha: 0.75,
            gravity: 0.25,
            drag: 1.6,
            phase: 0,
            twSpeed: 0,
        });
    }

    _burst(x, y, theme) {
        const r = this.rand;
        // 闪光核心:让爆点先出现一团高亮,再被球状粒子接上。
        this._spawn({
            kind: 'flash',
            x, y, z: 1.5,
            vx: 0, vy: 0,
            life: 0.26,
            size: 1.15,
            color: [1.0, 0.96, 0.86],
            alpha: 0.95,
            gravity: 0, drag: 0, phase: 0, twSpeed: 0,
        });

        const count = 190 + Math.floor(r() * 51); // 190-240
        const base = theme.rgb;
        for (let i = 0; i < count; i += 1) {
            const cosT = r() * 2 - 1;
            const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
            const phi = r() * Math.PI * 2;
            // 球面均匀方向,略微压扁 z(正交相机下 z 不改变屏幕位置,只给层次)
            const dx = sinT * Math.cos(phi);
            const dy = cosT;
            const dz = sinT * Math.sin(phi) * 0.35;
            const speed = 2.2 + r() * 4.6;
            const hueJitter = (r() - 0.5) * 0.22;
            const white = r() < 0.18;
            this._spawn({
                kind: 'burst',
                x, y,
                z: 1.5 + dz,
                vx: dx * speed,
                vy: dy * speed,
                life: 1.2 + r() * 1.6,
                size: 0.10 + r() * 0.11,
                color: white
                    ? [1.0, 0.98, 0.92]
                    : [
                        clamp(base[0] + hueJitter, 0, 1),
                        clamp(base[1] + hueJitter * 0.6, 0, 1),
                        clamp(base[2] - hueJitter * 0.4, 0, 1),
                    ],
                alpha: 0.55 + r() * 0.4,
                gravity: 3.0,
                drag: 0.9,
                phase: 0,
                twSpeed: 0,
            });
        }

        // 余烬:每发 >=12 个长寿命粒子;约 40% 铺到 8-12s 长尾,保证 P4 采样时刻仍存活。
        const embers = 18 + Math.floor(r() * 6); // 18-23
        for (let i = 0; i < embers; i += 1) {
            const long = (i % 5) < 2;
            const life = long ? 8.0 + r() * 4.0 : 3.0 + r() * 4.5;
            this._spawn({
                kind: 'ember',
                x: x + (r() - 0.5) * 0.5,
                y: y + (r() - 0.5) * 0.4,
                z: 1.6,
                vx: (r() - 0.5) * 1.1,
                vy: -0.15 - r() * 0.45,
                life,
                size: 0.26 + r() * 0.16,
                color: [1.0, 0.52 + r() * 0.22, 0.18 + r() * 0.12],
                alpha: 0.55 + r() * 0.3,
                gravity: 0.22,
                drag: 0.35,
                phase: r() * Math.PI * 2,
                twSpeed: 2.5 + r() * 4.5,
            });
        }
    }

    _spawn(p) {
        if (this.parts.length >= this.capacity) {
            // 容量兜底:丢弃最老的一个,绝不因溢出而崩溃。
            this.parts.shift();
        }
        const maxLife = p.life;
        p.maxLife = maxLife;
        p.r = p.color[0];
        p.g = p.color[1];
        p.b = p.color[2];
        p.a = p.alpha;
        this.parts.push(p);
    }

    update(dt) {
        this.time += dt;

        for (let i = this.rockets.length - 1; i >= 0; i -= 1) {
            const rocket = this.rockets[i];
            rocket.t += dt;
            const p = Math.min(1, rocket.t / rocket.dur);
            const eased = 1 - (1 - p) * (1 - p);
            rocket.x = rocket.targetX + rocket.jitter * (1 - p);
            rocket.y = rocket.startY + (rocket.targetY - rocket.startY) * eased;
            rocket.spawnAcc += dt * 105;
            while (rocket.spawnAcc >= 1) {
                rocket.spawnAcc -= 1;
                this._trail(rocket);
            }
            rocket.tick += 1;
            if ((rocket.tick & 1) === 0) {
                // 弹头本身的小光团
                this._spawn({
                    kind: 'trail',
                    x: rocket.x, y: rocket.y, z: 1.45,
                    vx: 0, vy: 0.1,
                    life: 0.12,
                    size: 0.13,
                    color: [1.0, 0.92, 0.70],
                    alpha: 0.9,
                    gravity: 0,
                    drag: 3.0,
                    phase: 0,
                    twSpeed: 0,
                });
            }
            if (p >= 1) {
                this._burst(rocket.x, rocket.y, rocket.theme);
                this.rockets.splice(i, 1);
            }
        }

        for (let i = this.parts.length - 1; i >= 0; i -= 1) {
            const p = this.parts[i];
            p.life -= dt;
            if (p.life <= 0) {
                this.parts[i] = this.parts[this.parts.length - 1];
                this.parts.pop();
                continue;
            }
            if (p.vy !== 0 || p.vx !== 0) {
                const damp = Math.exp(-p.drag * dt);
                p.vx *= damp;
                p.vy *= damp;
            }
            p.vy -= p.gravity * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }
    }

    /** 把所有粒子写进动态四边形场。 */
    writeQuads(field) {
        const time = this.time;
        for (let i = 0; i < this.parts.length; i += 1) {
            const p = this.parts[i];
            const lr = Math.max(0, p.life / p.maxLife);
            let alpha = 0;
            let size = p.size;
            if (p.kind === 'trail') {
                alpha = Math.min(1, lr * 1.8) * p.a;
                size = p.size * (0.45 + 0.8 * lr);
            } else if (p.kind === 'burst') {
                alpha = Math.pow(lr, 1.25) * p.a;
                size = p.size * (0.4 + 0.6 * Math.sqrt(lr));
            } else if (p.kind === 'ember') {
                const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(p.phase + p.twSpeed * time));
                alpha = Math.min(1, lr * 3.2) * p.a * tw;
                size = p.size * (0.86 + 0.18 * tw);
            } else { // flash
                alpha = Math.pow(lr, 2.0) * p.a;
                size = p.size * (1.5 - 0.5 * lr);
            }
            if (alpha <= 0.003) continue;
            // 预乘 alpha:加性混合用 ONE/ONE,不依赖管线对顶点 alpha 的解释。
            field.add(p.x, p.y, p.z, size, size, [p.r * alpha, p.g * alpha, p.b * alpha, 1]);
        }
    }
}
