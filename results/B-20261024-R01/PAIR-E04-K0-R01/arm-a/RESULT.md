# RESULT — PAIR-E04-K0-R01 / arm-a(three.js r186,K0)

## 0. 交付与环境

- 实现位置:`workspace/`(`index.html` + `src/{main,sky,city,particles,fireworks,textures}.js` → `dist/app.js`;three 与 addons 经 import map 从 `dist/vendor/` 提供),构建 `npm run build`,本地 serve `http://127.0.0.1:7106/`。
- 场景:正交相机"屏幕比例"世界坐标(高 1.0、宽 = 宽高比);夜空/星月/城市/窗灯/爆炸全部程序化(canvas 贴图 + 自定义 Points 着色器),无外部资产。
- 最终验证:2026-10-24T06:52:57Z,Chrome headless 1280×720,自检脚本 `workspace/scripts/selfcheck.mjs`,截图 `workspace/screenshots/selfcheck/01..13-*.png`,原始输出 `run5.txt`。
- 暂停/冻结语义:所有闪烁、窗灯、航空障碍灯、粒子均由 `simTime` 驱动;`enabled=false` 时 `dt=0`,uniform 不变 ⇒ 像素级冻结。

## 1. 实现摘要(逐 probe)

- **P1** 城市剪影 + 暖窗:26–30 栋楼合并为单一几何体(底部提亮、顶部渐暗的顶点色),窗灯为 Points 着色器(暖橙/暖黄、按列 18%/62% 点亮概率、尺寸 0.0042–0.0060);天空底部压暗、地平线光带中心在天际线(t≈0.33)且快速衰减,使剪影平均亮度显著低于地平线带;上部夜空为深蓝渐变 + 230 颗闪烁星 + 月亮。
- **P2** 点击发射:`canvas` 点击(排除右上 UI 区与城市剪影)调用 `launchAt(nx,ny)`;火箭从 y=-0.495 升空 0.78–1.08 s,`fireworkCount` 恰好 +1;上升中 300 粒/秒尾迹 + 亮头核,尾迹位于点击列 x∈[0.4,0.6] 的竖向带内。
- **P3** 爆炸:到达目标后 `burst` 生成闪光、核心光晕、180–220 粒球壳粒子(含 20% 白热与 55% 大光晕),`particlesAlive` 升至 300+;爆点邻域亮像素数为 P2 时刻 5.2 倍,随后衰减。
- **P4** 余烬:每次爆炸附 26 粒余烬(14 粒长尾,其中 4 粒寿命 12.0 s;其余 3.0–8.5 s),缓慢下坠 + 高频闪烁,`particlesAlive` 由峰值单调降至 <40;中心底部两帧差分 0.00546(≥0.005),8 s 时仍 0.00719,12.2 s 时仍有 9 粒存活。
- **P5** 自动表演:`data-ui="auto-show"` 按钮切换 `autoShow`;开启后每 0.5–1.1 s 随机发射(首发明帧触发),4 s 内 `fireworkCount` 由 1 增至 8(≥4)。
- **P6** 关闭自动:再次点击 `autoShow=false`,此后 `fireworkCount` 8→8 不变,存活粒子仅自然衰减(1613→475)。
- **P7** 暂停:点击 `data-ui="pause"` 置 `enabled=false`,渲染循环 dt=0,间隔 1000 ms 两帧全画面 diff 像素 0(0% < 0.5%)。
- **P8** 重置:点击 `data-ui="reset"` 清空粒子与在飞烟花、重新随机生成城市、清零 `fireworkCount`/`autoShow` 并恢复 `enabled=true`;状态全零、楼数 28(≥24),上部亮像素 700 回落至 P2 前基线 699。

最终自检实测(run5):

| Probe | 状态断言实测 | 视觉断言实测 |
|---|---|---|
| P1 | count 0, autoShow false, enabled true, 29 楼 | 底三分之一暖像素 478(≥80);剪影平均亮度 17.91 vs 地平线带 33.73;上部夜空 meanLuma 18.55 非纯黑 |
| P2 | 点击后 count 0→1,alive 154 | x∈[0.4,0.6] 竖带 diff 0.01068(1968 像素) |
| P3 | alive 320(≥40) | 爆点邻域 diff 0.0718,亮像素 643 vs P2 的 123(5.2x ≥3x) |
| P4 | alive 24(1≤·<40,峰值 320 → 单调下降) | center-bottom diff 0.00546(≥0.005);8.2 s 0.00719;12.2 s 仍 9 粒存活 |
| P5 | autoShow true,4 s 内 count 1→8(≥4) | 多发连续爆炸亮团(上部亮像素 3419) |
| P6 | autoShow false,count 8→8 | 无新发射,粒子自然衰减 |
| P7 | enabled false | 全画面 diff 0 像素(0% ≤ 0.5%) |
| P8 | count 0、alive 0、autoShow false、enabled true、28 楼 | 上部亮像素 700 ≈ 基线 699;城市剪影仍在 |

运行时无 console error / pageerror(`errors: []`);峰值存活粒子 1389(池容量 5200)。

## 2. 自检清单(§5 五项)

- [x] **1. `npm run build` 于 `workspace/` 根执行退出码 0** —— build #5,2026-10-24T06:51:13Z(`[build] OK`),产物自检通过。
- [x] **2. 页面 10 s 内 `window.__appReady === true`** —— 每次导航后首帧渲染即置位(导航~1 s 内),远小于 10 s;自检在 2.5 s 采样点已就绪。
- [x] **3. `window.__bench = { getState(): object, reset(): void }` 契约成立** —— `src/main.js` 中 `window.__bench = { getState, reset: doReset }`;`getState()` 返回 `{engine, fireworkCount, particlesAlive, autoShow, enabled, buildingCount}`,P8 通过 `reset` 路径同样验证。
- [x] **4. 无未捕获异常** —— 最终浏览器验证 `errors: []`(无 console error / pageerror)。
- [x] **5. 探针自检全部通过** —— 按 `spec.json` P1–P8 的状态断言与视觉断言逐条自查,最终轮(run5)全部通过,见上表。

## 3. 合规声明(§4 逐条)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问 `bench/results/` 下除本 Pair 本 Arm 之外的任何目录或既往 trial 结果。
4. 未访问 `harness/` 源码或本合同模板。
5. 未访问 `bench/vendor/` 及引擎上游源码仓库(`E:\AIProMax\github\cocosair.js`、three.js r186 源码树);three.js 仅经共享 node_modules 的已安装包以 import map 方式使用。
6. 未访问 `bench/docs/` 实验计划书与合同文档目录。
7. 未访问 `secret/`。
8. 未进行任何网络请求(无文档、无搜索、无 registry);本地 `127.0.0.1:7106` 仅为本 Arm 自建 dev server。
9. 未执行 `npm install`,未安装新依赖,未改动共享 node_modules。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值。
12. 未手改、伪造、删除或重置 `workspace/.budget/` 计数文件,未绕过 `count.mjs` / `verify-browser.mjs`:5 次 build、6 次浏览器会话均由计数脚本先行记录。

预算:build 5/8,浏览器验证 6/6,均在合同上限内;工具调用与墙钟由 Runner 侧计数。
