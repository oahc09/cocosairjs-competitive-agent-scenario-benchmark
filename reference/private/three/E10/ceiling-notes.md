# E10 Engine Ceiling Notes — three.js r186 (0.186.1) Reference 视角

目的:记录 Reference 实现中实际调用的引擎能力(= Three 侧 E10 天花板已验证部分)与遇到的版本现实/缺口,供 Cocos AIR 对照实验与路线图使用。场景:runtime GLB(蒙皮+多剪辑)双实例、动画状态隔离、销毁/reset 生命周期、材质灯光、≥30fps。

## 1. 能力清单(本 Reference 实测验证)

| # | 能力 | Three 用法 | 状态 |
|---|---|---|---|
| C1 | runtime GLB 加载(glTF 2.0,skin+animations+内嵌贴图) | `GLTFLoader.load('assets/character.glb')`,单请求 | ✓ 200/162KB,578ms 就绪 |
| C2 | 蒙皮网格克隆实例化(骨架独立) | `SkeletonUtils.clone(proto)` | ✓ 双实例,骨骼纹理每实例独立 |
| C3 | 每实例独立动画状态 | 每实例一个 `AnimationMixer(root)` + 独立 clipAction | ✓ A 切 walk 不影响 B(探针 P3) |
| C4 | 剪辑交叉淡化 | `action.fadeIn/fadeOut`(0.25s) | ✓ |
| C5 | 剪辑→骨骼蒙皮驱动(非冒充) | GLB AnimationClip 直接驱动 | ✓ Survey/Walk 原地化后仍全骨骼驱动 |
| C6 | 对象销毁(场景图移除+资源释放) | `scene.remove` + `mixer.stopAllAction/uncacheRoot` + `skeleton.dispose()` | ✓ B 存活续动(P5),A 区像素清空 |
| C7 | 从缓存数据重建实例(零新网络) | 保留 proto,reset 时重新 clone | ✓ 整会话 1 次 GLB 请求 |
| C8 | 三点布光+阴影 | 4 盏灯(Hemi+3×Directional),键光 PCF 1024 投影 | ✓ 接触阴影可辨 |
| C9 | 程序化材质(Canvas 纹理) | CanvasTexture(渐变穹顶/地坪/刻字) | ✓ |
| C10 | 性能 | 2 蒙皮实例 + 阴影,headless 真机 GPU | ✓ 60.2fps(阈 30) |
| C11 | 平滑环绕相机 | 球坐标 + 指数阻尼(+可选 OrbitControls,本实现手写) | ✓ |

## 2. Three r186 版本现实(实现时踩到的)

1. **PCFSoftShadowMap 已在 r186 移除**:设置后仅告警并回退 PCFShadowMap。软阴影观感上限较旧版本降低(VSM 仍在但噪点/漏光权衡)。→ 需写进 K 知识包,避免 Agent 空耗一轮警告。
2. **THREE.Clock 已弃用**(提示改用 THREE.Timer):本实现改 `performance.now()` 自计时零警告。
3. **AnimationClip 根位移无内置"原地化"**:GLB 带根位移的剪辑(本资产 Survey 漂 1.73、Walk 漂 2.25 单位)必须手工冻结 position 轨道,否则角色走离展台;`SkeletonUtils.retargetClip` 并不解决根位移剥离。
4. **实例资源所有权靠自律**:SkeletonUtils.clone 共享 geometry/material,销毁时只能释放每实例 `skeleton.dispose()`(boneTexture);误 dispose 共享几何/材质会打死存活实例——引擎无所有权/引用计数模型,生命周期正确性完全在应用层。
5. `mixer.uncacheRoot(root)` 是 mixer 侧解除绑定的正路(不调用则 PropertyBinding 缓存滞留,阻 GC)。

## 3. 对 Cocos AIR 的 E10 对照问题清单(Arm 实现前值得预判)

> 以下为 Three Reference 视角提炼的"若 AIR 无对应物则可能触发的失败分类",供 pair 分析,非结论。

| 能力点 | Three 验证 | AIR 待验证 | 风险失败分类 |
|---|---|---|---|
| GLB runtime 加载(单请求可观测) | ✓ | glTF 内建支持(官方声明) | ASSET_PIPELINE(低) |
| **蒙皮层级深克隆(等价 SkeletonUtils.clone)** | ✓ 核心 API | 是否存在"克隆含 skin 的节点树且骨架状态独立"?若无,双实例须两次实例化同一资产数据(仍禁二次网络) | SCENE_GRAPH / LIFECYCLE_MISUSE(高) |
| 每实例独立 mixer/action/time | ✓ | 动画状态对象是否可按实例隔离 | ANIMATION(高,场景核心观测点) |
| 每实例骨骼 GPU 资源释放 | ✓ skeleton.dispose | 销毁语义是否完整(不殃及共享缓存) | LIFECYCLE_MISUSE |
| 交叉淡化 | ✓ fadeIn/Out | 是否有等价权重过渡 API | ANIMATION(中,可手写权重) |
| 根位移剪辑处理 | 手工冻结轨道 | 同样需要;若 glTF 运行时把根位移烘焙进节点,剥离难度更高 | ANIMATION(中高) |
| 阴影 | PCF(注意 r186 无 PCFSoft) | MASTER-CONTEXT 已知短板"阴影交付不完整" | MATERIAL/POSTPROCESS(视觉分项) |
| 状态契约暴露 | 纯 JS | Code-first 应无障碍 | — |

## 4. Three 侧 E10 天花板结论

- **FEASIBLE**:全部 7 探针 + 完成合同 + 性能阈值一次通过;无引擎阻断项。
- ComparableScore(自评口径)≈ 94/100(Objective 60 + Visual 34),细节见 REFERENCE-VERDICT.md。
- 天花板受限处(非阻断):软阴影降级(PCFSoft 移除)、无后处理必要项未用(特效维度上限自评 2/3)、根位移原地化与实例资源所有权均为手工模式——这些是"引擎给得出但需应用层自律"的典型差异点,预计在 AIR 侧被放大的正是 2/3 两类。
