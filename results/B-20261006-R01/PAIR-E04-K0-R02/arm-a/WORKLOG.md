# WORKLOG — PAIR-E04-K0-R02 / Arm A (cocosair, K0)

```text
2026-10-05T23:20:00Z+08:00 | 读 RUN-CONTRACT/brief/spec/模板/知识包 + 引擎 d.ts API 调研 | 成功(动态网格 createDynamicMesh+updateSubMesh / Material.initialize / input.on / 正交相机 / 程序化贴图 API 确认)
2026-10-05T23:31:00Z+08:00 | 编写 workspace/src/main.js(E04 全场景:夜空渐变+星点/程序化楼群+亮窗+障碍灯/烟花粒子系统/UI/状态契约) | 成功
2026-10-05T23:32:07Z+08:00 | build #1(npm run build) | 成功(dist/app.js 27.1kb,引擎 external)
2026-10-05T23:32:30Z+08:00 | 浏览器验证 #1(shot1-initial + 合成点击 eval) | 失败(app.js 抛未捕获异常:buildCity 内残留 horizonRenderer.mesh 空引用)
2026-10-05T23:33:08Z+08:00 | build #2(移除 buildCity 中残留的地平线辉光构建块) | 成功
2026-10-05T23:33:19Z+08:00 | 浏览器验证 #2(shot + 点击测试 + 像素行分析) | 部分成功(输入链路✓ count=1/alive=41,但静态网格渲染错乱:整屏乱飞的长三角形)
2026-10-05T23:34:30Z+08:00 | 根因定位:静态 utils.MeshUtils.createMesh 读 geometry.indices,动态 updateSubMesh 才读 indices16;缺 indices → 无索引绘制 → 四边形被画成跨屏长三角 | 成功
2026-10-05T23:35:32Z+08:00 | build #3(accumToGeometry 同时提供 indices 拷贝 + indices16) | 成功
2026-10-05T23:35:34Z+08:00 | 浏览器验证 #3(shot2-initial) | 成功(夜景完全正常:渐变夜空+星点+楼群剪影+暖窗+障碍灯+地平线辉光+右上 UI)
2026-10-05T23:37:07Z+08:00 | 浏览器验证 #4(完整 P1-P8 探针自检脚本:状态断言+readPixels 视觉断言+帧差分) | 成功但两项运动证据偏弱(P2 尾迹帧差 0.0039、P4 余烬帧差 0.0023,均低于 0.005 参考阈值;其余全过、P7 冻结 diff=0)
2026-10-05T23:39:55Z+08:00 | build #4(尾迹加密+纵向拉伸+亮头部;余烬 20→28 增亮增大小+强闪烁) | 成功
2026-10-05T23:39:57Z+08:00 | 浏览器验证 #5(P1-P8 全量复测) | 成功(P2 diff 0.0188 / P3 爆点行 0.694≈目标 0.70 / P4 diff 0.0059 / P5 Δcount=5 / P6 冻结✓ / P7 diff=0 / P8 归零✓,无 console 错误)
2026-10-05T23:41:34Z+08:00 | build #5(余烬 28→30、加大小,抬 late-sampling 运动余量) | 成功
2026-10-05T23:41:35Z+08:00 | 浏览器验证 #6(P1-P8 全量终检 + 烟花 Active 截图) | 成功(P1-P8 全部通过:P2 0.0230 / P3 4.07x、爆点行 0.700 / P4 0.0080 / P5 Δ6 / P6 冻结 / P7 0 / P8 归零;console 0 错误;browser 预算 6/6 用满,验证终止)
2026-10-05T23:45:00Z+08:00 | 撰写 RESULT.md | 成功
```

备注:
- dev server 一直在后台运行(PORT=7134,`npm run dev`),供正式探针采样复用。
- 自检截图与探针脚本存于 `selfcheck/`(shot1/shot2 初始夜景、shot3、shot4、probe-script.js)。
- 预算终值:build 5/8、browser 6/6(触顶即停,后续不再创建浏览器会话)。
