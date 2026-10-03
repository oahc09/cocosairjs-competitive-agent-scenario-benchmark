# WORKLOG — E08 深海鱼群 Reference(Three.js r186)

- runId: `REF-E08-three`
- 日期:2026-10-02(UTC+8)
- 工作区:`bench/reference/private/three/E08/`
- 产物:单文件应用 `src/main.js`(~700 行),模板 build/serve 不变

## 迭代记录

| 轮次 | 构建 | 验证 | 探针 | 结论 |
|---|---|---|---|---|
| R1 | PASS | FAIL | P1–P5 PASS,P6 FAIL(5/8) | 惊散/进食冲突 |
| R2 | PASS | FAIL | P1–P5 PASS,P6 FAIL(5/8) | 食物存活期 < 采样时刻 |
| R3 | PASS | **PASS** | 8/8,fps 60.2 | 全绿 |
| R4(final,--video) | PASS | **PASS** | 8/8,fps 60.1,video.webm | 终版 |

构建全部一次通过(esbuild,无引擎 API 试错);修复轮次 2 次,均为**行为/时序调参**,非 API 错误。

## 关键实现决策

1. **鱼体**:LatheGeometry 车削纺锤体(16 段剖面)+ 压扁圆锥尾鳍 + 背鳍 + 双胸鳍,`mergeGeometries` 拼合;头朝 +Z,`InstancedMesh` ×110,逐实例颜色(`setColorAt`)。
2. **摆尾**:实例属性 `aPhase/aWag` + `onBeforeCompile` 注入顶点着色器行波(`sin(aPhase − z·2.4)`,尾幅 ~0.29 世界单位),相位在 CPU 按个体速度积分 → 每实例独立频率/幅度;转弯侧倾(roll)由偏航率驱动。
3. **boids**:O(n²) 对称对遍历(110² /2 ≈ 6k 对/帧),SoA Float32Array,零每帧分配;软边界回推 + 硬钳制保证不出取景框。
4. **avgCohesion**:冻结公式 `1 − min(1, 个体到质心平均距离/10)` 每帧从真实位置计算,常态稳态 ~0.60,惊散 ~0.17。
5. **惊散**:指针 raycast 到 z=0 平面得世界坐标,与鱼做**真实 3D 距离**判定(<2.8);最短持续 2.2s(惊魂未定);scatter 模式:聚集权重×0.03、分离半径 3.35、逃逸力(半径 9.5,权重 34)、极速 13。
6. **重聚**:scatter→normal 切换后 4.2s 窗口内聚集权重×3.2、极速 9.5(实测 P4 采样时 cohesion 0.54)。

## 两次修复的根因(重要教训,供 AIR 侧对照)

### R1 失败:惊散与趋食互斥
P5 点击后指针**静止悬停在食物点**;鱼群被食物吸引靠近指针 → 反复落入惊散触发半径 → 模式永久 scatter → 大半径逃逸力持续压制趋食 → 鱼群永远聚不到食物(avgDist 卡在 ~7)。
**修复**:投喂期间"进食压过恐惧"——触发判定跳过 + 恐慌参数组(`panic = scatter && !food.active`)不生效。无食物时惊散仍是纯距离判定(P3/P4 路径不变)。

### R2 失败:低估 harness 每探针开销
P6 断言采样时刻 = 点击后 **~10.9s**(截图 + pngjs 重编码使每探针开销 ~1–4s,远超名义 waitMs 推算的 ~7.5s),而食物 9.5s 超时已消失。
**修复**:用独立 playwright 复现脚本实测食物生命周期曲线(avgDist 4.4→2.7、死亡时刻 9.6s)定位;食物超时 16s(brief 允许 ≥8s)、啃食速率 0.07/s(全程可见地缩小,P6 采样时 health ~0.4)。
**给 Agent 的通用教训**:探针 `waitMs` ≠ 采样时刻;设计动态状态存活期时必须按 waitMs + 2×视觉断言耗时 + 4 张截图编码冗余估算。

## 最终指标(R4)

- probes:8/8 PASS(passRate 1.0),S2 行为项 10/10 对应
- fps 60.1(minFps 30);console errors 0;uncaught 0
- 首帧 litRatio 0.44(nonBlank 阈 0.25)
- 生命周期:P7 reset 后 resetCount=1、foodActive=false、mode=normal、计数不变
- 证据:`validation/report.json`、`validation/probe-results.json`、`validation/video.webm`、`validation/screenshots/`(38 张)
