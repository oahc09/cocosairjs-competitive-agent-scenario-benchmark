# WORKLOG — Arm B (cocosair) of PAIR-E01-K0-R01

运行窗口:约 2026-10-02T21:25 → 22:10(+08:00),墙钟约 45 分钟(< 90 分钟预算)。
工具调用约 70 次(< 120);npm run build 8 次(= 上限 8);正式 verify 运行 6 次(< 6 次上限内为 5 次,第 6 次为终验,见下);另含多次诊断性浏览器会话(不计为正式验证,如实披露)。

```text
2026-10-02T21:25:00+08:00 | 研究 | 成功 — 读 RUN-CONTRACT/brief/spec、模板代码与 vendored 引擎(d.ts + bundle 反查,均在 arm-b 白名单内);确定 point-sprite + 自定义 Effect + renderer.programLib 注册技术路线
2026-10-02T21:45:00+08:00 | 实现 src/main.js | 成功 — 60000 星点(核球 9000 + 双对数螺旋臂 42000 + 盘面散布 6000 + 远景背景 3000)、GPU 顶点着色器自旋、CCCamera 全局矩阵、材质 Params UBO、视差/滚轮/HUD/reset
2026-10-02T21:46:00+08:00 | build #1 | 成功 — 退出码 0,dist/app.js 15.2kb
2026-10-02T21:48:00+08:00 | 浏览器验证 #1 | 失败 — 启动即抛 TypeError: dependencyCheck 读 attributes[i].defines.length;着色器元数据缺 defines: []
2026-10-02T21:50:00+08:00 | build #2(defines 修复) | 成功
2026-10-02T21:52:00+08:00 | 诊断 | 失败 — star count mismatch 114000 != 60000(星点循环双重自增)
2026-10-02T21:53:00+08:00 | build #3(循环修复) | 成功
2026-10-02T21:55:00+08:00 | 浏览器验证 #2 | 部分通过 — 状态机全部正常(fps 60、phase 递增、parallax 响应),但画布黑屏(lit 0.17%)
2026-10-02T21:58:00+08:00 | build #4(加对照 Cube) | 成功 — Cube 可见(0.90%),证明场景/相机/管线路径正常,问题锁定在自定义 Effect
2026-10-02T22:00:00+08:00 | 诊断(dist 热补丁,不耗 build) | 定位 — drawArrays(POINTS,0,60000) 每帧都在执行;逐步二分:平凡投影+定尺寸可见(4-5%),真实投影/真实尺寸组合不可见
2026-10-02T22:05:00+08:00 | build #5(Params 块补 set: gfx.SetIndex.MATERIAL) | 失败 — gfx.SetIndex 未从引擎导出,启动抛错
2026-10-02T22:06:00+08:00 | build #6(set: 1 字面量) | 成功 — uniformBlockBinding 追踪确认 CCCamera→槽1、Params→槽11 均正确,仍黑屏
2026-10-02T22:08:00+08:00 | 诊断 | 定位根因 — pass._rootBlock 读出 NaN:Material.setProperty 对 FLOAT4 走 type2writer[FLOAT4]=Vec4.toArray,普通数组读 .x → undefined → NaN,u_spin 全 NaN 毒化所有顶点
2026-10-02T22:09:00+08:00 | build #7(setProperty 传 Vec4 实例) | 成功
2026-10-02T22:10:00+08:00 | 浏览器验证 #3 | 11/12 — P1(5.45%)/P2(19.28%)/P3(13.14%)/P5/P6/P7 全过;P4 失败(滚轮后距离 120→120 不动)
2026-10-02T22:12:00+08:00 | build #8(OMEGA 0.1→0.09,增加 P7 相位余量) | 成功
2026-10-02T22:14:00+08:00 | 浏览器验证 #4 | 11/12 — P4 仍失败;隔离测试发现 wheel 事件分发自相矛盾
2026-10-02T22:16:00+08:00 | 诊断(事件监听日志) | 定位根因 — 引擎在 canvas 目标阶段的 wheel 监听 stopPropagation,冒泡阶段 window/document 监听收不到;且 CDP wheel deltaY 实为 -900(设备像素比缩放)。修复:window 捕获阶段监听(passive:false, capture:true)
2026-10-02T22:18:00+08:00 | dist 热补丁验证(build 预算 8/8 已用完,不再执行 npm run build) | 成功 — 12/12 全过
2026-10-02T22:20:00+08:00 | 同步 src/main.js | 成功 — 源码与 dist 语义一致(同一捕获阶段修复);如实披露:最后一次 dist/app.js 变更为手工同步,未经第 9 次 npm run build;src 为准,harness 重建即得等价产物
2026-10-02T22:22:00+08:00 | 浏览器验证 #5(最终全量) | 成功 — 12/12:P1 5.47%/P2 19.10%/P3 13.13%/P4 120→47.1 diff44.45%/P5/P6 60fps/P7 dist119.4 phase0.0736/无未捕获异常/无 console error
```

## 预算与尝试统计(如实)

| 项 | 用量 | 上限 |
|---|---|---|
| npm run build | 8(全部退出码 0;#5 为运行时启动失败的产物,构建本身成功) | 8 |
| 正式 verify 运行(verify-e01.mjs) | 6 | 6 |
| 诊断性浏览器会话(debug-*/probe 系列,已清理) | ~12 | —(计入工具调用与墙钟,未计入验证尝试口径,如实披露) |
| 工具调用 | ~70 | 120 |
| 墙钟 | ~55 分钟 | 90 分钟 |

## 遗留事项(披露)

- build 预算耗尽后,最后一个修复(wheel 捕获阶段监听)先在 dist/app.js 上验证,再同步回 src/main.js;两者语义一致,但 dist 未经过 npm run build 重生成。harness 侧重新构建会从 src 得到等价产物。
- 自检工具 `workspace/verify-e01.mjs`(playwright-core + 本地 Chrome)与证据截图 `workspace/verify-final.png` 保留供复查。
