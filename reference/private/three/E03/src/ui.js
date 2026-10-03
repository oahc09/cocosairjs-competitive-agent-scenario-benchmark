// ============================================================================
// ui.js — E03 DOM 覆盖层:信息卡 / 时间倍率五档控件 / Reset / 状态读数
// ----------------------------------------------------------------------------
// 探针契约(harness 以 [data-ui=...] 定位):
//   data-ui="info-card"  信息卡(选中时可见,含行星名 + >=3 个数据字段)
//   data-ui="speed-0.5x" | "speed-1x" | "speed-2x" | "speed-4x" | "speed-8x"
//   data-ui="reset"      Reset 按钮
// ============================================================================

const SPEEDS = [0.5, 1, 2, 4, 8];
const CSS = `
  #hud { position: fixed; inset: 0; pointer-events: none; z-index: 10;
         font: 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #d9e4ff;
         text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
  #hud .panel { background: rgba(9, 14, 26, 0.78); border: 1px solid rgba(126,164,224,0.4);
                border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
  #hud .dock { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
               display: flex; align-items: center; gap: 8px; padding: 8px 12px; pointer-events: auto; }
  #hud .dock .lbl { font-size: 11px; letter-spacing: 0.14em; color: #8fa5cf; margin-right: 2px; }
  #hud .dock button { pointer-events: auto; cursor: pointer; font: 600 12.5px "Segoe UI", system-ui, sans-serif;
                      color: #cdd9f5; background: rgba(38,50,78,0.9); border: 1px solid rgba(110,140,200,0.45);
                      border-radius: 6px; padding: 4px 11px; transition: background 0.15s, color 0.15s; }
  #hud .dock button:hover { background: rgba(58,76,118,0.95); }
  #hud .dock button.active { background: #3d8bff; border-color: #8fc0ff; color: #fff;
                             box-shadow: 0 0 10px rgba(72,140,255,0.65); }
  #hud #reset-btn { position: fixed; top: 14px; right: 14px; pointer-events: auto; cursor: pointer;
                    font: 600 12.5px "Segoe UI", system-ui, sans-serif; color: #e8eefc;
                    background: rgba(120,52,52,0.85); border: 1px solid rgba(220,120,120,0.55);
                    border-radius: 8px; padding: 6px 16px; transition: background 0.15s; }
  #hud #reset-btn:hover { background: rgba(160,64,64,0.95); }
  #hud .info-card { position: fixed; right: 20px; top: 50%; transform: translateY(-50%);
                    width: 236px; padding: 14px 16px; pointer-events: auto; }
  #hud .info-card.hidden { display: none !important; }
  #hud .info-card h3 { margin: 0 0 2px; font-size: 17px; letter-spacing: 0.06em; color: #9fd8ff; }
  #hud .info-card .sub { font-size: 10.5px; color: #7f92bd; margin-bottom: 9px; }
  #hud .info-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; }
  #hud .info-card dt { color: #8fa5cf; font-size: 11.5px; }
  #hud .info-card dd { margin: 0; color: #eaf1ff; font-size: 12px; font-variant-numeric: tabular-nums; }
  #hud .readout { position: fixed; bottom: 16px; left: 16px; padding: 5px 10px;
                  font-size: 11.5px; color: #aebfe6; font-variant-numeric: tabular-nums; }
`;

/**
 * 创建 HUD。回调:onSpeed(newScale)、onReset()。
 * 返回 { setSpeedActive, showInfo, hideInfo, tick }。
 */
export function createUI({ onSpeed, onReset }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const hud = document.createElement('div');
  hud.id = 'hud';

  // ---- 时间倍率五档控件 ----
  const dock = document.createElement('div');
  dock.className = 'dock panel';
  dock.setAttribute('data-ui', 'time-controls');
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = 'TIME SCALE';
  dock.appendChild(lbl);
  const speedButtons = new Map();
  for (const s of SPEEDS) {
    const b = document.createElement('button');
    const tag = `${s}x`;
    b.textContent = tag;
    b.setAttribute('data-ui', `speed-${tag}`);
    b.setAttribute('aria-label', `time scale ${tag}`);
    b.addEventListener('click', () => onSpeed(s));
    dock.appendChild(b);
    speedButtons.set(s, b);
  }
  hud.appendChild(dock);

  // ---- Reset ----
  const resetBtn = document.createElement('button');
  resetBtn.id = 'reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.setAttribute('data-ui', 'reset');
  resetBtn.setAttribute('aria-label', 'reset');
  resetBtn.addEventListener('click', () => onReset());
  hud.appendChild(resetBtn);

  // ---- 信息卡(初始隐藏,点击行星驱动出现) ----
  const card = document.createElement('aside');
  card.className = 'info-card panel hidden';
  card.setAttribute('data-ui', 'info-card');
  card.innerHTML = '<h3 id="ic-name"></h3><div class="sub">PLANET DATA</div>' +
    '<dl>' +
    '<dt>Type</dt><dd id="ic-type"></dd>' +
    '<dt>Orbit Radius</dt><dd id="ic-orbit"></dd>' +
    '<dt>Orbital Period</dt><dd id="ic-period"></dd>' +
    '<dt>Moons</dt><dd id="ic-moons"></dd>' +
    '<dt>Rotation</dt><dd id="ic-rot"></dd>' +
    '</dl>';
  hud.appendChild(card);

  // ---- 状态读数 ----
  const readout = document.createElement('div');
  readout.className = 'readout panel';
  readout.textContent = 'SIM 0.0s · 1x · -- fps';
  hud.appendChild(readout);

  document.body.appendChild(hud);

  let lastReadout = '';
  return {
    setSpeedActive(scale) {
      for (const [s, b] of speedButtons) b.classList.toggle('active', s === scale);
    },
    showInfo(cfg) {
      card.querySelector('#ic-name').textContent = cfg.name.charAt(0).toUpperCase() + cfg.name.slice(1);
      card.querySelector('#ic-type').textContent = cfg.type;
      card.querySelector('#ic-orbit').textContent = `${cfg.orbitRadius} AU`;
      card.querySelector('#ic-period').textContent = `${cfg.period} sim s`;
      card.querySelector('#ic-moons').textContent = String(cfg.moons ? cfg.moons.length : 0);
      card.querySelector('#ic-rot').textContent = `${cfg.spin} sim s`;
      card.classList.remove('hidden');
    },
    hideInfo() {
      card.classList.add('hidden');
    },
    tick(simTime, scale, fps) {
      const txt = `SIM ${simTime.toFixed(1)}s · ${scale}x · ${Math.round(fps)} fps`;
      if (txt !== lastReadout) {
        readout.textContent = txt;
        lastReadout = txt;
      }
    },
  };
}
