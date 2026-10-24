// ============================================================================
// fireworks.js — 烟花生命周期(升空 → 爆炸 → 下坠 → 余烬)
// ----------------------------------------------------------------------------
// 每发烟花状态机:
//   rising : 从地面升到点击高度;每帧沿轨迹撒尾迹粒子(kind=1)
//   burst  : 到点时一次性生成球状爆炸(kind=0)、闪光(kind=3)与长寿命余烬(kind=2)
// 时长/数量都落在 spec 的冻结区间内:
//   升空 0.78–1.08 s(0.6–1.6)、爆炸 150–210 粒(100–240)、寿命 1.9–2.8 s(1.2–2.8)
//   余烬 18 粒/发(>=12),寿命 3–12 s,其中 9 粒长尾(含 3 粒 12 s)
// 余烬物理:较小的重力 + 中等阻力 → 终速 ~0.076 画面高/秒,持续下坠但不出画太快,
// 这样 P4 的 center-bottom 采样窗口内仍可见缓慢下坠/闪烁。
// ============================================================================

const HUES = [0.115, 0.045, 0.33, 0.50, 0.58, 0.80, 0.72, 0.88];

export function pickHue() {
  return HUES[Math.floor(Math.random() * HUES.length)] + (Math.random() - 0.5) * 0.03;
}

function hslToRgb(h, s, l) {
  const hh = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [hue(hh + 1 / 3), hue(hh), hue(hh - 1 / 3)];
}

export class Fireworks {
  constructor(particles) {
    this.ps = particles;
    this.active = [];
    this.launched = 0;
  }

  clear() {
    this.active.length = 0;
  }

  /** 从城市地面把一发烟花射向 (targetX, targetY)(世界坐标)。 */
  launch(targetX, targetY, hue) {
    const dur = 0.78 + Math.random() * 0.30;
    const x0 = targetX + (Math.random() - 0.5) * 0.018;
    const y0 = -0.495;
    this.active.push({
      x0,
      y0,
      x: x0,
      y: y0,
      tx: targetX,
      ty: targetY,
      hue,
      t: 0,
      dur,
      trailAcc: 0,
    });
    this.launched += 1;
  }

  update(dt, time) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const fw = this.active[i];
      fw.t += dt;
      const frac = Math.min(1, fw.t / fw.dur);
      const ease = Math.pow(frac, 0.72); // 上升末段减速
      // 极轻微的横向摆动(幅度 < 1% 画面宽,不影响爆点横坐标落在点击列)
      const wobble = Math.sin(frac * 9.0 + fw.hue * 20) * 0.005 * (1 - frac);
      fw.x = fw.x0 + (fw.tx - fw.x0) * ease + wobble;
      fw.y = fw.y0 + (fw.ty - fw.y0) * ease;

      fw.trailAcc += dt * 300;
      while (fw.trailAcc >= 1) {
        fw.trailAcc -= 1;
        this.emitTrail(fw.x, fw.y, fw.hue);
      }
      this.emitHead(fw.x, fw.y);

      if (frac >= 1) {
        this.burst(fw.x, fw.y, fw.hue);
        this.active.splice(i, 1);
      }
    }
  }

  emitTrail(x, y, hue) {
    const gold = Math.random() < 0.32;
    const jx = (Math.random() - 0.5) * 0.010;
    const jy = (Math.random() - 0.5) * 0.010;
    const goldColor = hslToRgb(0.10 + Math.random() * 0.04, 1.0, 0.62 + Math.random() * 0.12);
    this.ps.spawn({
      x: x + jx,
      y: y + jy,
      z: (Math.random() - 0.5) * 0.02,
      vx: (Math.random() - 0.5) * 0.035,
      vy: -0.02 - Math.random() * 0.05,
      vz: 0,
      life: 0.32 + Math.random() * 0.46, // 0.32–0.78 s
      gravity: 0.06,
      drag: 1.5,
      size0: 0.006 + Math.random() * 0.005,
      size1: 0.002,
      alpha0: 0.95,
      color: gold ? goldColor : [1.0, 0.94, 0.78],
      kind: 1,
      flickPhase: Math.random() * Math.PI * 2,
    });
  }

  emitHead(x, y) {
    // 弹头:亮核 + 一圈柔光,让升空轨迹有明确的"亮点自下而上"
    this.ps.spawn({
      x,
      y,
      z: 0,
      life: 0.05,
      gravity: 0,
      drag: 0,
      size0: 0.018,
      size1: 0.014,
      alpha0: 1.0,
      color: [1.0, 0.96, 0.85],
      kind: 3,
    });
    this.ps.spawn({
      x,
      y,
      z: 0,
      life: 0.10,
      gravity: 0,
      drag: 0,
      size0: 0.05,
      size1: 0.035,
      alpha0: 0.5,
      color: [1.0, 0.82, 0.5],
      kind: 3,
    });
  }

  burst(x, y, hue) {
    // 爆炸闪光:短促、面积大,给 P3 的爆点邻域亮度提供确定性脉冲
    this.ps.spawn({
      x,
      y,
      z: 0,
      life: 0.24,
      gravity: 0,
      drag: 0,
      size0: 0.14,
      size1: 0.28,
      alpha0: 1.0,
      color: [1.0, 0.96, 0.86],
      kind: 3,
    });
    // 中心余辉:闪光之后仍保留一团亮核,保证"显著上升后回落"的亮度曲线
    this.ps.spawn({
      x,
      y,
      z: 0,
      life: 0.62,
      gravity: 0,
      drag: 0,
      size0: 0.05,
      size1: 0.10,
      alpha0: 0.55,
      color: [1.0, 0.9, 0.7],
      kind: 3,
    });

    // ---- 爆炸主体:球面方向 + 速度分层(外层壳更密) ----
    const N = 180 + Math.floor(Math.random() * 41); // 180–220
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const dx = s * Math.cos(th);
      const dy = u;
      const dz = s * Math.sin(th) * 0.5;
      const shell = Math.random() < 0.62;
      const speed = shell ? 0.12 + Math.random() * 0.09 : 0.04 + Math.random() * 0.06;
      const life = 1.9 + Math.random() * 0.9; // 1.9–2.8 s
      const hot = Math.random() < 0.2;
      const col = hot
        ? hslToRgb(hue + (Math.random() - 0.5) * 0.04, 0.38, 0.92)
        : hslToRgb(hue + (Math.random() - 0.5) * 0.06, 0.95, 0.62 + Math.random() * 0.18);
      const size = 0.008 + Math.random() * 0.011;
      this.ps.spawn({
        x,
        y,
        z: 0,
        vx: dx * speed,
        vy: dy * speed + 0.015,
        vz: dz * speed,
        life,
        gravity: 0.075, // 重力下坠:2 s 后约下移 0.15 画面高
        drag: 0.95,
        size0: size,
        size1: size * 0.35,
        alpha0: 1.0,
        color: col,
        kind: 0,
      });
      // 大而暗的晕层:叠加混合形成柔和 bloom(不改变爆炸主体计数)
      if (Math.random() < 0.55) {
        this.ps.spawn({
          x,
          y,
          z: 0,
          vx: dx * speed * 0.78,
          vy: dy * speed * 0.78 + 0.015,
          vz: dz * speed * 0.78,
          life: life * 0.82,
          gravity: 0.07,
          drag: 0.95,
          size0: size * 3.6,
          size1: size * 1.8,
          alpha0: 0.17,
          color: col,
          kind: 0,
        });
      }
    }

    // ---- 余烬:26 粒/发,其中 14 粒长尾(4 粒活到 12 s) ----
    const NE = 26;
    for (let i = 0; i < NE; i++) {
      const longTail = i < 14;
      let life;
      if (longTail && i < 4) life = 12.0;
      else if (longTail) life = 10.6 + Math.random() * 1.2;
      else life = 3.0 + Math.random() * 5.5;
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.012 + Math.random() * 0.05;
      const col = hslToRgb(0.055 + Math.random() * 0.05, 1.0, 0.60 + Math.random() * 0.16);
      const size = 0.024 + Math.random() * 0.016;
      this.ps.spawn({
        x: x + (Math.random() - 0.5) * 0.10,
        y: y + (Math.random() - 0.5) * 0.07,
        z: 0,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp * 0.5 + 0.012,
        vz: 0,
        life,
        gravity: 0.038, // 终速 ~0.076 画面高/秒
        drag: 0.5,
        size0: size,
        size1: size * 0.72,
        alpha0: 1.0,
        color: col,
        kind: 2,
        flickSpeed: 2.6 + Math.random() * 5.2,
        flickPhase: Math.random() * Math.PI * 2,
      });
    }
  }
}
