# WORKLOG — arm-b PAIR-E04-K0-R01 (E04 城市烟花夜 / cocosair / K0)

格式:`<ISO-8601 时间戳> | <动作> | <结果(成功/失败+一句话原因)>`

> 说明:本 Arm 经历两次派发。首次派发(2026-10-05 09:16Z)被平台瞬时错误中断,留下部分产物
> (main.js 初版、selfcheck.eval.js、shot-s1.png);.budget 机器计数文件中的 09:40Z build 与
> 09:43Z browser 两条即该次尝试的合法计数(由系统侧记录,非本次运行补写)。本次为重派发后的
> 连续运行,自 09:55Z 起,以下条目均为本次运行实际动作。

```text
2026-10-05T09:40:24.454Z | build(#1,首次派发的中断尝试) | 成功(系统计数继承;该尝试随后于 09:43Z 做浏览器自检后中断,未交付 WORKLOG/RESULT)
2026-10-05T09:43:36.914Z | 浏览器验证(#1,首次派发的中断尝试) | 成功(系统计数继承;其截图 shot-s1.png 暴露:星点/障碍灯 quad 被拉成以灭点为中心的放射状条纹 —— 1×1×1 box 的 z 厚度在透视下被放大)
2026-10-05T09:55:23Z | run 启动 | 重派发启动,读 RUN-CONTRACT/brief/spec,盘点继承状态(1 build + 1 browser 已耗)
2026-10-05T09:58:30Z | 代码审查(main.js) | 发现继承实现存在关键 bug:fire() 把点击的"自上原点" nyTop 直接当作粒子物理 y(自下原点)使用,爆点相对点击位置垂直镜像(P2/P3 必挂);星点条纹已在该次 17:51 的继承编辑中以 setScale z=0.02 压薄修复
2026-10-05T09:59:40Z | 修复 fire() 轴向换算 | 成功:y1 = clamp((1-nyTop)±0.03, 0.38, 0.88),y0=0.22,dist=y1-y0;同时用 K0 d.ts 核实 input 单例、getLocation(左下原点)/getLocationInView(视图)语义,均与实现一致
2026-10-05T10:05:24Z | build(#2,本次运行第 1 次) | 成功:npm run build 退出码 0,dist/app.js 20.2kb,引擎 external(sha256=4e73650324d0f351bdc233aa36a506936f302902a4f179ac15d12e20ff8e548a)
2026-10-05T10:07:43Z | 浏览器验证(#2,本次运行第 1 次) | 成功:verify-browser --eval selfcheck.eval.js 全流程自检;appReady=true、consoleErrors=0、uncaught=0;lastClick={0.5,0.30} 精确;P1 warmBottom=1055/星点像素 469/剪影 11.8<天空带 24.5;P2 fc=1、运动差分 0.0364、亮带均值 y 0.577→0.478(上升);P3 particlesAlive=143、上半屏亮像素 376→5654、爆带 y≈0.41(未镜像);P4 粒子数 102→39→16→9 单调下降、~7.3s 余烬 9 颗 ∈[1,40)、center-bottom 运动差分 0.00708≥0.005;P5 autoShow=true、4s 内 fc 1→6、fps=57;P6 fc 冻结(8→8,Δ=0);P7 enabled=false、全帧两帧差分=0.0;P8 全状态归零、楼数 26、上半屏亮像素回落 352≈基线 376
2026-10-05T10:08:50Z | 截图复核(shot-s2.png) | 成功:星点已为圆点状,夜空渐变/楼群剪影/亮窗/红色障碍灯/右上角 UI 全部符合 Visual Direction
2026-10-05T10:09:40Z | 收尾 | 写 RESULT.md;预算终态 build 2/8、browser 2/6、无任何红线触碰
```
