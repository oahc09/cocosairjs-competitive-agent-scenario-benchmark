# E08 深海鱼群 — Cocos AIR Reference VERDICT

## 结论

**FEASIBLE(PASS)** — E08 全部合同与 8/8 探针在 Cocos AIR `cocosair.js@1.0.0` 上可完整实现,无 ENGINE_LIMITED 项。

## 最终验证(REF-E08-cocosair-FINAL,--video,端口 7420)

| 项 | 结果 |
|---|---|
| build | ok,exit 0(1 次尝试) |
| __appReady / __bench | true(1.4s)/ 可用 |
| 探针 | P1–P8 全 PASS(passRate 1.0) |
| fps(harness 3s rAF 采样) | **60.3**(minFps 合同 30) |
| console 错误 / 未捕获异常 | 0 / 0 |
| 产物 | report.json、8+ 截图、video.webm(5.9MB)、state 样本 |

## 状态合同实测(最终轮采样)

- 常态:`fishCount=110, planktonCount=340, boidMode=normal, avgCohesion≈0.81`
- 惊散(P3 拖拽后 1.2s):`boidMode=scatter, avgCohesion≈0.17–0.33`(<0.35 合同)
- 重聚(P4 角落 6s):`normal, avgCohesion≈0.81`(≥0.45 合同,远超)
- 投喂(P5):`foodActive=true, foodPosition={0, 0.20, 0.008}`(点击射线∩水域中心深度平面)
- 聚食(P6):`avgDistanceToFood≈4.3–4.5`(<6 合同)
- reset(P7):`foodActive=false, avgDistanceToFood=null, boidMode=normal, resetCount+1`

## 行为项(scoring.behaviorItems)自检

1. 鱼 ≥80 且程序化形体 ✓(110 条,分节六棱身体+背鳍+叉形尾鳍+摆尾形变,与 fishCount 一致)
2. 聚集规则 ✓(常态 avgCohesion 0.81,抱团可辨)
3. 对齐规则 ✓(邻域速度对齐权重,整体朝向趋同)
4. 分离规则 ✓(反比平方斥力,最小间距,无穿插)
5. 鼠标接近惊散 ✓(射线距离判定,scatter 且 cohesion<0.35,炸开可辨)
6. 指针离开 6s 内重聚 ✓(实测 ~2.2s 滞回 + <2s 重聚)
7. 点击投喂 ✓(食物颗粒+光晕出现,foodActive/foodPosition 真实)
8. 聚食闭环 ✓(avgDist<6,可被啄食消耗或 ≥8s 超时消失)
9. 悬浮颗粒 ≥300 持续漂浮 ✓(340,billboard+缓漂+缓慢上浮回绕)
10. reset 恢复初始 ✓(固定种子,模拟继续运行)

## 禁止捷径遵守

- 逐帧 boids O(n²) 真实模拟,无预烘焙轨迹/路径巡游
- 3D 网格实体(非广告牌/DOM 冒充),fishCount 与画面一致
- 惊散仅由指针-鱼 3D 距离触发(scatter 滞回是威胁历史的函数,无定时器脚本)
- 状态字段全部来自当帧模拟量
- reset 不刷新页面
