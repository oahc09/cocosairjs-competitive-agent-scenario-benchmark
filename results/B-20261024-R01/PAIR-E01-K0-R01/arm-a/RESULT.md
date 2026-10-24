# RESULT — Arm A (three.js r186) / PAIR-E01-K0-R01

场景:E01 深空星系巡航。实现文件:`workspace/src/main.js`(构建产物 `workspace/dist/`)。
交付形态:一次 `npm run build` 产出 `dist/app.js`(13.4KB)+ 本地 vendored three,`index.html` 经 import map 引用;无任何外部资产(assets/ 完全未使用)。

## 1. 实现摘要

**总体结构**:固定种子 PRNG(mulberry32 + Box–Muller)在启动时程序化生成两组星点缓冲——
星系 60,000 颗(核球 6,500 + 盘面 53,500:72% 对数螺旋旋臂 / 28% 盘面散星,3 条旋臂,`theta = b·ln(r/r0)`,b=2.4)
+ 远景静止星 8,000 颗(半径 520–1400 的球壳)。两组各为**一次 `THREE.Points` 绘制**(无逐星提交),
`starCount = 68,000` 与真实提交渲染的点数严格一致(HUD 同值)。
材质为自定义 `ShaderMaterial`:圆形点精灵 + 中心辉光衰减 + Reinhard 高光压缩(避免密集核球直接裁成纯白,保留暖/蓝色相),
点径 `aSize·(bufferHeight/(2·tan(fov/2)))·0.5 / 相机深度`,即距离衰减——近距星点自然放大变疏。
颜色沿半径梯度:核球暖黄 `#ffc97a→#ffe9c6`,旋臂中段蓝白 `#b9d4ff`,外缘冷蓝 `#4a69ff`,并按 1% 比例散布橙红亮星;
亮度分三档:核球亮星 / 旋臂普通星 / 暗弱盘星(另有远景微光星),满足多层级可辨。

- **P1** `starCount ≥ 50000`:两缓冲合计 68,000 点、2 次 draw call 真实提交;截图像素统计亮像素占比 11.4%(阈值 2%),
  星系盘面与核球在截图中清晰可辨,背景为纯色 RGB(5,6,11)(暗于 16,16,24,无渐变/色带)。
- **P2** 旋转:`phase += OMEGA·dt`,OMEGA=0.04 rad/s(规格 0.02–0.1),`galaxyGroup.rotation.y = phase` 刚性绕盘面法线旋转;
  2s 采样窗口实测 Δphase = 0.0807 rad > 0.001;画面中心 80% 区域存在大量运动像素(跨会话两帧像素差 6.65%)。
- **P3** 指针视差:`pointermove`/`mousemove`(window 级)把指针相对画布中心的归一化偏移写入目标,指数平滑(PARALLAX_TAU=0.4s);
  相机沿右/上基向量平移 `distance·0.08·offset`(屏幕位移约 4%,≤10%),星系与远景因深度不同产生相对位移;
  实测拖动到 (0.68,0.50) 后 parallaxOffset.x 由 0.2277 → 0.3305(采样窗内仍在变化),画面像素显著变化。
- **P4** 滚轮穿行:`wheel`(passive:false + preventDefault)按 `exp(deltaY·0.0009)` 指数缩放目标距离并夹在 [40,400],
  距离用 1s smoothstep 逐帧插值(不瞬跳);deltaY=-600 实测 120 → 94.96(500ms)→ 74.36(800ms),Δ>5,构图明显变化。
- **P5** HUD:左上角固定面板(`data-ui="hud"`),单行文本 `STARS 68000 / FPS 60 / DIST 120` 与 `getState()` 同源(每帧同步、四舍五入显示),
  `hudVisible` 由包围盒 + 计算样式判定为 true;面板不遮挡星系主体。
- **P6** 帧率:2s 滚动平均(rAF 时间戳窗口),空闲态实测 59.99–60.00 fps,远超 30;68,000 点仅 2 次绘制,headless 稳定 60。
- **P7** Reset:HUD 内可见按钮(`data-ui="reset"`,文本 "Reset",`aria-label="reset"`),点击后 epoch+1、相位归零、
  视差目标与当前值归零、距离以 0.55s smoothstep 平滑回到 120(实测 300ms 时 98.38 → 900ms 时 120,非瞬跳);无整页刷新
  (`performance.getEntriesByType('navigation').length = 1`),连续 3 次 reset epoch=3、行为一致。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] 1. `npm run build` 退出码 0(`workspace/`,3 次构建全部成功,产物自检 OK,dist/index.html 引用 app.js 与 vendored three)。
- [x] 2. 页面加载后 `window.__appReady === true`(verify-browser 在 10s 轮询内实测 true,首帧渲染后置位)。
- [x] 3. `window.__bench = { getState(), reset() }` 契约成立,getState 键恰为
      `starCount / rotationPhase / cameraDistance / parallaxOffset / fps / hudVisible / epoch`。
- [x] 4. 无未捕获异常(5 次浏览器会话 `uncaught=[]`、`consoleErrors=0`)。
- [x] 5. 探针自检:P1–P7 状态断言逐条实测通过(数值见第 1 节与 WORKLOG),视觉断言以首帧截图 + 像素统计
      (亮像素 11.4%、HUD 区 4.8%、跨帧差分 6.65%)交叉确认。

预算使用(机器计数):build 3 / 8,browser 5 / 6,工具调用远低于 120,墙钟约 10 分钟。

## 3. 合规声明

逐条对照 RUN-CONTRACT §4:

1. 未访问另一 Arm 的任何目录、代码、日志、服务、浏览器 profile、截图或结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问本 Pair 本 Arm 之外的任何结果目录,未读取任何既往 trial 结果。
4. 未读取 `harness/` 源码与合同模板(仅执行本 Arm 模板自带的构建/计数/浏览器脚本)。
5. 未访问 `vendor/` 引擎资产目录,亦未访问 three.js r186 或 cocosair.js 上游源码仓库;依赖全部来自上层共享 node_modules。
6. 未访问实验计划书/合同文档目录(`docs/`)。
7. 未访问 `secret/`。
8. 未联网:无任何网络请求(页面无外部 URL,验证仅走本机 127.0.0.1:7100)。
9. 未执行 `npm install`,未新增或改动任何依赖。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 行为与期望值。
12. 未手改/伪造/删除/重置 `workspace/.budget/*.count`;所有构建均经 `npm run build`(内含 count.mjs),所有浏览器会话均经 `scripts/verify-browser.mjs`,计数完整。

另:仅在本 Arm 目录内创建工作文件(`workspace/src/main.js` 实现、`workspace/index.html` 标题、`WORKLOG.md`、`RESULT.md`
与自检用的 `_selfcheck/` 诊断脚本/截图),未改动 `assets/`、`knowledge/` 与模板脚本;结束时已停止 dev server 释放端口 7100。
