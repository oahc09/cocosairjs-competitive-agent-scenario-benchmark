# WORKLOG — PAIR-E10-K0-R01 / arm-a (three, K0)

```text
2026-10-03T18:01:00+08:00 | 材料 | 读取 RUN-CONTRACT/brief/spec/knowledge/assets;character.glb 解析:clips=[Survey,Walk,Run],skins=1 joints=24,材质带嵌入贴图,无扩展依赖
2026-10-03T18:02:30+08:00 | 资产 | 复制 assets/character.glb -> workspace/assets/character.glb(sha256=d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7 与 spec 一致;dev server 根为 workspace,相对路径请求需可达;原 assets/ 只读未动)
2026-10-03T18:05:00+08:00 | 实现 | 写 workspace/src/main.js:GLTFLoader 单次加载,SkeletonUtils.clone 双实例,独立 mixer/材质,UI data-bench 控件组,__bench 状态契约
2026-10-03T18:06:00+08:00 | 实现 | 写 workspace/scripts/probe-check.mjs(自检用;会话前先执行 count.mjs browser,不绕过预算)
2026-10-03T18:08:20+08:00 | build | npm run build #1 退出码 0(count: build #1;dist/app.js 8.9kb,three/addons external,vendor 504 文件)
2026-10-03T18:09:00+08:00 | serve | PORT=7124 node scripts/serve.mjs 启动,GET / 与 /assets/character.glb、/dist/app.js 均 200
2026-10-03T18:10:35+08:00 | 浏览器验证 | probe-check 全流程(browser #1):P1-P7 全 PASS,fps=60,GLB 请求恰 1 次且 200,零 console error / pageerror
2026-10-03T18:12:10+08:00 | 探针自检 | 截图目检:材质/阴影/灯光正确,但双实例呈背面朝向且实例 A 尾部越出画面左缘(违反"完整入画"意图) -> 定位为朝向参数错误
2026-10-03T18:14:00+08:00 | 修复 | FACE_YAW(π-0.55,背面)改为每实例 yaw A=+0.45 / B=-0.45(GLB 原生面向局部 +Z),面向相机对称 3/4 侧身,剪影收窄入区
2026-10-03T18:15:30+08:00 | build | npm run build #2 退出码 0(count: build #2)
2026-10-03T18:16:40+08:00 | 浏览器验证 | probe-check 全流程(browser #2):P1-P7 全 PASS;截图目检:双实例正面 3/4 朝向、完整入画、材质/接触阴影正确
2026-10-03T18:18:05+08:00 | 浏览器验证 | verify-browser.mjs(browser #3):appReady=true,benchReady=true,零异常;早期采样 fps=22 系首帧着色器编译启动抖动混入 60 帧窗口(稳态 P7 采样为 60) -> 诊断非场景性能问题
2026-10-03T18:20:30+08:00 | 修复 | fps 统计改为仅累计 __appReady 之后的帧(排除启动抖动,"最近 60 帧"口径更忠实)
2026-10-03T18:22:10+08:00 | build | npm run build #3 退出码 0(count: build #3)
2026-10-03T18:23:30+08:00 | 浏览器验证 | probe-check 全流程(browser #4):P1-P7 全 PASS,稳态 fps=60/61,GLB 请求恰 1 次,零异常
2026-10-03T18:25:00+08:00 | 浏览器验证 | verify-browser.mjs 最终验证(browser #5):appReady=true,benchReady=true,consoleErrors=0,uncaught=[],早期 fps=59
2026-10-03T18:26:00+08:00 | serve | dev server 已停止(端口 7124 释放)
2026-10-03T18:27:00+08:00 | 交付 | 写 RESULT.md(实现摘要/自检清单/合规声明)
```

预算实耗(诊断口径,判定以 harness budget-check 读取 .budget 机器计数为准):

- buildAttempt:3 / 8
- browserAttempt:5 / 6(全部经 count.mjs browser 先计后会话:probe-check 自身先调 count.mjs,verify-browser.mjs 内建计数)
