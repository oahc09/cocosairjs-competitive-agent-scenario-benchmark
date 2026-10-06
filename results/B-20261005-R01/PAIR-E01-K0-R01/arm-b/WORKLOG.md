# WORKLOG — PAIR-E01-K0-R01 / Arm B (cocosair, K0)

> 时间戳均为 ISO-8601 UTC(与 workspace/.budget 机器计数同口径)。

```text
2026-10-05T03:56:43Z | 启动 | Agent 开始(execution.json 盖章);读 RUN-CONTRACT.md/brief.md/spec.json/knowledge/workspace 模板
2026-10-05T04:05:00Z | 案头研究 | 成功:K0 知识包仅 README;k0 包(node_modules)内 d.ts + bundle 反射确认 API 面——utils.MeshUtils.createMesh 支持 colors(RGBA32F)/uvs(RG32F)/primitiveMode/indices;内置 effect 清单含 builtin-billboard(technique "add":加法混合+depthWrite off+双面,VS 以 cc_matViewInv 展开相机朝向面片,FS col=2*color*tintColor*tex);决定规避 POINT_LIST 双补丁与 gl_PointSize 缺失风险,采用"单网格四边形 billboard"批量渲染
2026-10-05T04:20:00Z | 实现 | 成功:重写 workspace/src/main.js(58,000 星=旋臂24k+盘散14k+暗星8k+核球8k+远景4k,单 TRIANGLE_LIST 网格+共享 billboard 材质;程序化 64×64 径向辉光纹理;rotationPhase 0.05rad/s;滚轮/视差平滑;HUD+Reset(data-ui=reset/aria-label=reset);__appReady/__bench 契约);index.html 仅改标题与背景色
2026-10-05T04:24:52Z | build #1 | 成功:退出码 0(esbuild 14.4kb,引擎 external)
2026-10-05T04:25:04Z | serve + 浏览器验证 #1 | 成功:PORT=7101 dev server 起服;verify-browser:appReady=true、__bench 就绪、console error 0、无未捕获异常,state={starCount:58000,rotationPhase:0.018,cameraDistance:120,fps:62,hudVisible:true};截图 arm-b-shot1.png 发现渲染异常:星点呈放射状长条(bug)
2026-10-05T04:33:52Z | 浏览器验证 #2(诊断) | 成功:--eval 抓取网格布局/GL attribs/uniform——mesh stride=36、interleave 数据正确、glAttribs off=[0,12,20] 正确、cc_size_rotation=(1.7,1.7,0,0) 已写入 UBO、tintColor=(1,1,1,1);排除 attrib/uniform 嫌疑
2026-10-05T04:36:32Z | 浏览器验证 #3(诊断) | 成功:index.html 注入 shaderSource 钩子捕获引擎实际编译的 GLSL:billboard VS/FS 与 bundle 内预编译变体一致(vertOffset=a_texCoord-0.5,偏移上界 0.85 世界单位)——渲染异常在数学上不可能来自偏移路径
2026-10-05T04:36:45Z | 浏览器验证 #4(诊断) | 成功:补抓 vs_main 尾部与 FS,确认无出入;锁定期望:异常只能来自顶点/索引供给
2026-10-05T04:39:37Z | 浏览器验证 #5(诊断) | 成功:dump 索引缓冲——indexView.stride=2(u16),实际索引流 [0,1,2,0,2,3, 1,2,3,1,3,4, ...]:每星 vi 只 +1 而非 +4,四边形索引跨到相邻星心 → 长条=跨星三角形;根因定位(main.js star() 的 vi += 1 应为 += 4)
2026-10-05T04:41:28Z | build #2 | 成功:vi += 4 修复(galaxy/bg 两处)+ 顶点数校验改为 ×4
2026-10-05T04:41:36Z | 浏览器验证 #6 | 成功:截图 arm-b-shot2.png 确认旋涡星系正确渲染(≥2 条对数旋臂、明亮核球、半径色梯度、橙红亮星、远景星层、盘厚);state 正常,fps=64;browserAttempt 至此 6/6 用满,此后不再创建浏览器会话
2026-10-05T04:44:00Z | 案头复核 | 成功:按 probeConventions 时序复核 P3/P4/P7,发现原"距离指数平滑(rate5)"在 P4 采样窗(wait500ms→+300ms)内位移仅 ~2.3 单位,不满足 after<before-5;改为滚轮=线性滑行 28u/s(窗内恒定 8.4 单位,与窗口位置无关)+ reset=指数 rate6(0.8s 内 84→119.7)
2026-10-05T04:47:59Z | build #3 | 成功:距离控制律修改
2026-10-05T04:48:30Z | 探针状态断言桌面仿真 | 成功:scripts/simulate-probes.mjs 以同一控制律(dt=1/60)仿真——P4 两种采样语义+窗口抖动均 PASS(margin≥0.6);P7 dist=119.70∈[115,125]、|parX|=5e-5<0.01、phase=0.04<0.1;400→120 极端 reset 0.95s→120.94 PASS;P3 before/after 差 1.9e-3;P2 相位 2s 增量 0.1>0.001
2026-10-05T04:49:00Z | 视觉断言像素统计 | 成功:scripts/png-crop.mjs(--stats)对 arm-b-shot2.png 计算亮像素占比=9.55%(阈值 ≥2%,lit=87,968px @ lum>40/255)——P1/P6 nonBlank 证据
2026-10-05T04:50:52Z | build #4 | 成功:清理(main.js 移除 rx0 残留、index.html 移除临时 shaderSource 诊断钩子、删除 inspect-effects.mjs 与调试裁剪图)后重建,退出码 0
2026-10-05T04:51:30Z | 收尾 | 写 RESULT.md;停止本 Arm dev server(释放 7101 供正式验证);预算终态:build 4/8、browser 6/6、墙钟 ~55min/90min
```
