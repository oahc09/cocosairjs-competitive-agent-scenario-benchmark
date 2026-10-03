# WORKLOG — PAIR-E10-K0-R01 Arm B (engine: three)

时间戳 ISO-8601(本地 +08:00)。Run 起点 2026-10-02T21:23(+08:00)。

```text
2026-10-02T21:25+08:00 | 阅读 | 成功 — 读 RUN-CONTRACT.md / brief.md / spec.json / knowledge(README+manifest)/ assets(MANIFEST+VALIDATION);解析 character.glb JSON 块(Khronos Fox:24 关节蒙皮,clips=Survey/Walk/Run,含 PNG 贴图,身高~79 单位)
2026-10-02T21:28+08:00 | 资产准备 | 成功 — character.glb 原样拷贝 arm-b/assets -> workspace/assets,sha256=d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7 与 spec.json 冻结值一致(源文件未修改)
2026-10-02T21:33+08:00 | 实现 | 成功 — 重写 workspace/src/main.js:GLTFLoader 单次加载 assets/character.glb,SkeletonUtils.clone 派生双实例,每实例独立 AnimationMixer(idle->Survey, walk->Walk),三点布光+半球光、渐变背景、地面接触阴影、展台圆盘、data-bench/data-ui 控件组、getState/reset 契约、fps(60 帧滑动平均);index.html 仅改 title;新增 scripts/probe-verify.mjs 探针自检脚本
2026-10-02T21:35+08:00 | build #1 | 成功 — npm run build 退出码 0(自检 OK,app.js 11.6KB)
2026-10-02T21:35+08:00 | serve | 成功 — PORT=7107 node scripts/serve.mjs;合同 §0 表列 7101 而括号指示 PORT=7107,两者矛盾,按括号的显式环境变量指示取 7107;curl /index.html 与 /assets/character.glb 均 200
2026-10-02T21:36+08:00 | 浏览器验证 #1(probe-verify) | 部分成功 — 17/19:P2 FAIL 系自检脚本未允许剪辑循环回绕(spec §8 明确允许);P4 FAIL 系自检截图取自销毁完成之后两帧(应用行为本身正确:销毁状态断言 PASS)
2026-10-02T21:38+08:00 | 浏览器验证 #2 | 部分成功 — 布局数值分析命令误触发 probe-verify 再次整跑(非计划内消耗,计入预算);同样 17/19,结论同上
2026-10-02T21:40+08:00 | 探针自检(数值布局) | 成功 — p1-vs-p4a 差分隔离实例 A 像素:bbox x102-531/y200-457,中心 316(区域中心 319),A/B 间距 211px,采样色 (155,86,25)/(177,102,28) 证实贴图正确渲染;据此将角色高度 1.28->1.22 留边,并修正自检脚本 P2(允许回绕)/P4(销毁前取帧)
2026-10-02T21:44+08:00 | build #2 | 成功 — 退出码 0
2026-10-02T21:44+08:00 | 浏览器验证 #3(probe-verify) | 部分成功 — 19/20:仅剩 P5 系自检脚本同类回绕严格性问题(应用行为正确)
2026-10-02T21:46+08:00 | 浏览器验证 #4(probe-verify) | 成功 — 20/20 全过(__appReady 344ms;nonBlank A=0.277/B=0.341;切换时延 17ms;销毁区域变化 0.186;reset 无新请求;fps=60;零 console 错误)
2026-10-02T21:50+08:00 | build #3 | 成功 — build.mjs 增加 dist/assets 拷贝步骤(dist/index.html 独立 serve 可用),退出码 0;dist/assets/character.glb sha256 与冻结值一致
2026-10-02T21:50+08:00 | 浏览器验证 #5(probe-verify 最终) | 成功 — 22/22 全过(新增 P3b 双向隔离:B 切 Walk 不影响 A,再切回 Idle A 仍 Walk)
2026-10-02T21:52+08:00 | 浏览器验证 #6(soak-verify,预算末次) | 成功 — 35s 连续运行 fps=60 恒定、instanceCount 稳定、JS 堆 -3.6%(无增长)、零错误;销毁 A 后 10s:B 动画推进(1.10s->2.68s)、fps 60 不降;/dist/index.html、/dist/app.js、/dist/assets/character.glb 均 200
2026-10-02T21:58+08:00 | serve 停止 | 成功 — dev server(7107)已停止
```

预算消耗:工具调用 ~30/120;墙钟 ~35/90 分钟;build 3/8;浏览器验证 6/6(其中 #2 为误触发,如实计入)。
