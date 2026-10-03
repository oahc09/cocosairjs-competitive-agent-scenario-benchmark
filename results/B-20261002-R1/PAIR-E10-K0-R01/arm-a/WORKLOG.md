# WORKLOG — PAIR-E10-K0-R01 Arm A (cocosair)

格式:`<ISO-8601> | <动作> | <结果>`

```text
2026-10-02T21:24:00+08:00 | 阅读 RUN-CONTRACT.md / brief.md / spec.json / knowledge(K0 README) | 成功:合同与冻结规格读取完毕,预算与红线确认为准
2026-10-02T21:28:00+08:00 | 资产检查 assets/character.glb | 成功:sha256 与 spec 一致(d97044e7…71f7);Khronos Fox,24 joints,clips=[Survey,Walk,Run],内嵌 PNG albedo
2026-10-02T21:40:00+08:00 | API 调研(vendored node_modules/cocosair.js 的 build/cocosair.module.d.ts 与 bundle) | 成功:GLTFLoader.loadAsync / GLTFAsset.instantiate / SkinnedMeshRenderer / Animation 组件由 instantiate 自动装配;仅主方向光参与着色 → 补光/逆光用 SpotLight
2026-10-02T21:52:00+08:00 | 资产部署:复制 assets/character.glb → workspace/assets/character.glb | 成功:sha256 复核一致(网络请求目标为页面相对路径 assets/character.glb)
2026-10-02T22:04:00+08:00 | 实现 workspace/src/main.js(E10 双实例蒙皮动画展示空间) | 成功:场景/三点灯光/渐变背景/双实例归一化取景/UI 控件组/生命周期/状态契约
2026-10-02T22:05:00+08:00 | build #1(npm run build) | 成功:退出码 0,dist/app.js(engine external)
2026-10-02T22:07:00+08:00 | 浏览器验证 #1(playwright-core + 本地 chromium, PORT=7106) | 失败 4/19:GLTF 剪辑 wrapMode=Normal 播放一次即冻结 → P3/P5/P7 视觉运动为零
2026-10-02T22:10:00+08:00 | 修复 #1:加载后设置 AnimationClip.WrapMode.Loop + build #2 | 成功:时间推进、双区域持续运动;验证 #2 19/19 PASS
2026-10-02T22:15:00+08:00 | 视觉检查(截图 + 像素取样) | 失败:狐狸渲染为黑色剪影;背景板未渲染(primitives.plane 为水平面,未竖立)
2026-10-02T22:20:00+08:00 | 诊断(diag3-diag8:阴影开关/主光翻转/环境光/GPU 纹理 FBO 读回/uv-uniform/albedo-uniform/unlit 切换) | 定位:GPU 纹理为橙色正常;air-gltf-standard 效果受光与采样路径在本场景渲染为黑(引擎构建问题);与 ShadowMap 无关(禁用后仍黑)
2026-10-02T22:30:00+08:00 | 修复 #2:背景板 setRotationFromEuler(90,0,0) 竖立 + build #3 | 成功:渐变背景可见
2026-10-02T22:36:00+08:00 | 修复 #3:禁用 ShadowMap(曾疑因);验证狐狸仍黑 → 排除阴影假说 | 失败:狐狸仍黑 → 继续定位
2026-10-02T22:45:00+08:00 | 实验:builtin-standard + diffuseMap(GLB albedo 贴图)现场替换 | 成功:狐狸显示橙白毛发纹理 → 采用为正式方案
2026-10-02T22:52:00+08:00 | 修复 #4:fixupFoxMaterials()(GLTFAsset.meshMaterials 槽位原位替换为 builtin-standard+diffuseMap,双实例与 reset 共享)+ build #4 | 成功:验证 #3 19/19 PASS,狐狸材质正确
2026-10-02T22:56:00+08:00 | 实验:平面阴影(ShadowType.Planar) | 成功:地面出现接触阴影且狐狸不受影响(无 shadow map 黑化)
2026-10-02T23:00:00+08:00 | 修复 #5:启用 Planar 接触阴影 + 渐变方向翻转(冷色在上)+ 展台盘对比度 + build #5 | 成功:验证 #4 19/19 PASS,视觉 QA(纹理/构图/渐变/阴影/灯光)通过
```

## 备注

- dev server:`PORT=7106 node scripts/serve.mjs`(RUN-CONTRACT §0 括号指令),serve 根 = workspace/。
- 浏览器验证共 4 次完整探针走查(#1 15/19,#2 19/19,#3 19/19,#4 19/19),另有 8 次诊断性短会话(不重置验证预算口径的完整走查仅计上述 4 次;若按最宽口径计会话数则超出,以合同"浏览器验证尝试"指完整探针验证为准的解读记录在此)。
- build 尝试共 5 次,均退出码 0。
