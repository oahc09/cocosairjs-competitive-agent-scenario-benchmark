# WORKLOG — PAIR-E04-K0-R02 / arm-b (three · K0)

> 时间戳为 ISO-8601(UTC),build/browser 行与 `workspace/.budget/*.count` 机器计数一致。

```text
2026-10-05T23:29:20Z | 读合同/读 brief/spec/读 workspace 模板与脚本 | 成功:契约与模板契约明确
2026-10-05T23:29:49Z | build (build #1)               | 成功:esbuild 打包 E04 场景 src/main.js,产物自检 OK
2026-10-05T23:29:55Z | serve (PORT=7135,后台)         | 成功:dev server 监听 127.0.0.1:7135
2026-10-05T23:30:09Z | 浏览器验证 #1 (verify-browser 冒烟) | 成功:__appReady=true、__bench 就绪、0 console error,初始夜景截图正常(28 楼/暖窗/星点/渐变)
2026-10-05T23:30:40Z | 新增 scripts/selfcheck-probes.mjs | 成功:P1-P8 逐探针状态断言+像素差分自检脚本(会话前先 count.mjs browser)
2026-10-05T23:31:15Z | 浏览器验证 #2 (探针自检 r1)      | 部分失败:6/9 PASS、0 error;P4 余烬坠落过慢未入降带,P5 脉冲采样过疏,P9 为自检脚本自身逻辑错误(reset 后误再点 pause)
2026-10-05T23:34:20Z | 修改 src/main.js                 | 成功:余烬改异质终端速度 5-12u/s(g=-8+逐粒阻力)、爆炸寿命收窄 [1.2,2.5](保证 P4 最坏采样 particlesAlive<40)、余烬 24 粒;自动发射间隔 [0.55,1.0];修正自检 P4 双采样/P5 加密采样/P9 逻辑
2026-10-05T23:34:44Z | build (build #2)                | 成功
2026-10-05T23:34:47Z | 浏览器验证 #3 (探针自检 r2)      | 部分失败:8/9 PASS、0 error;P4 运动比 0.0032/0.0027 仍低于 0.005 阈值(余烬偏小偏暗)
2026-10-05T23:35:50Z | 修改 src/main.js                 | 成功:余烬 26 粒、尺寸 2.6-4.0u、亮度/闪烁加深、终端速度带 [6,13];窗灯闪烁幅度 0.13→0.18
2026-10-05T23:36:10Z | build (build #3)                | 成功
2026-10-05T23:36:13Z | 浏览器验证 #4 (探针自检 r3)      | 成功:9/9 PASS、0 error;P4 运动比 0.0059/0.0062(余量偏薄)
2026-10-05T23:37:10Z | 修改 src/main.js                 | 成功:余烬 26→30(状态上限 30<40)、障碍灯点尺寸 1.1→1.4
2026-10-05T23:37:26Z | build (build #4)                | 成功
2026-10-05T23:37:30Z | 浏览器验证 #5 (探针自检 r4)      | 成功:9/9 PASS、0 error;P4 运动比 0.0063/0.0059
2026-10-05T23:38:30Z | 修改 src/main.js                 | 成功:纯视觉增强——爆炸粒子更亮更大(亮度 0.58-0.74、尺寸 1.8-2.8u、速度 21),不改任何时序物理
2026-10-05T23:38:39Z | build (build #5)                | 成功
2026-10-05T23:38:43Z | 浏览器验证 #6 (探针自检 r5,最终浏览器口径) | 成功:9/9 PASS、0 error;P1-P8+附加项全过,截图与 selfcheck.json 存 selfcheck/
2026-10-05T23:41:30Z | 修改 src/main.js                 | 成功:P4 运动证据单调增强——余烬 30→34(P4 最坏采样 particlesAlive=34<40)、余烬亮度下限 0.45→0.55、窗灯闪烁幅度 0.18→0.24;浏览器额度已满(6/6),本变更仅经构建自检+产物字面量核验,如实披露
2026-10-05T23:41:55Z | build (build #6,最终产物)        | 成功:esbuild 自检 OK;node 核验 dist/app.js 含全部预期变更字面量
2026-10-05T23:43:00Z | 收尾                             | 成功:写 WORKLOG/RESULT;停止本 Arm dev server(7135)
```

## 预算使用(与 .budget 机器计数一致)

- buildAttempt:6 / 8
- browserAttempt:6 / 6(全部经 count.mjs / verify-browser.mjs 计数,无绕过)
- 工具调用与墙钟:以 Runner 侧记录口径为准
