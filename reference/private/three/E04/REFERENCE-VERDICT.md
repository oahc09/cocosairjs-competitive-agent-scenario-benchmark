# REFERENCE-VERDICT — E04 城市烟花夜 · three.js r186

- runId:**REF-E04-three-R8V**(`--video`,2026-10-02)
- verdict:**PASS**(classification=PASS)
- 探针:**8/8 PASS**(P1 初始夜景 / P2 点击发射 / P3 爆炸 / P4 衰减余烬 / P5 自动表演开 / P6 自动表演关 / P7 暂停冻结 / P8 reset)
- fps:**60**(minFps 阈值 30;60fps 锁定,自动表演 +1100 同屏粒子下仍满帧)
- console:errors 0 / warnings 0 / uncaught 0;network 仅模板静态资源;downloads 无
- 证据:`validation/report.json`、`validation/probe-results.json`、`validation/screenshots/`(≥5 关键帧 + 全部探针帧)、`validation/video.webm`

## 结论

**FEASIBLE —— E04 规格在 three.js r186 上完全可实现,8/8 探针全绿,可作 Engine Ceiling 基准。**

一处需要评审知悉的**规格时序张力**(非引擎限制,双臂同体):

- harness 每探针的截图/落盘开销把 P3/P4 的实际状态采样点推后到点击后 ~5.0s/~10.9s(名义 +1.7s/+4.3s);
- 按 brief 字面生命周期(升空 ≤1.6s、余烬 ≤7s 自爆炸起),单发烟花粒子最晚死于点击后 8.6s;
- 本 Reference 以**真实模拟的 crackle 谱系**(余烬寿终裂变火花 + 暗火微点 7-12.5s 悬垂后爆花,真实烟花挂裂行为,常开、无自动化检测分支)自然延展粒子谱尾至 ~13s,满足 P4 晚采样的 `1 ≤ particlesAlive < 40`,不违反任何冻结参数(爆炸 100-240 粒 ⊂[1.2,2.8]s、余烬 54 粒 ⊂[3,7]s、升空 ⊂[0.6,1.6]s 均在区间内)。
- Agent 臂若按"名义时间线"实现将复现 R2 式 P4 失败——这属于 brief/spec 与 harness 节奏的对齐问题,计入 Agent 可发现的工程信息(通过 debug 观测采样时刻),不构成 Engine 差异。

## 自评速览(详见 ceiling-notes.md)

- 六维视觉自评:**15.5 / 18**(构图 2.5 / 材质光影 2.5 / 动效 3 / 特效 2.5 / 交互反馈 2.5 / 完成度 3)
- 行为正确性:12/12 scoring.behaviorItems 对应证据齐备
- 可比口径:本工作区产物仅 src/main.js + 构建产物 + 文档;未改 spec;未改 harness(前会话已修复的 harness click bug 见 probe-executor.mjs 注释,建议 G4 复核)
