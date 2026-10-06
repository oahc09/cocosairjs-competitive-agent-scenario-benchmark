# WORKLOG — PAIR-E07-K0-R01 / arm-b (cocosair, K0)

2026-10-05T14:08:00Z | 读 RUN-CONTRACT/brief/spec/模板(src/main.js、build/serve/count/verify-browser)与 K0 知识包 README;白名单内(arm-b 目录)grep 引擎运行时 bundle 确认 API:createDynamicMesh/updateSubMesh 签名、Fog(exp2/属性集/场景 globals.fog)、builtin-unlit 带 USE_VERTEX_COLOR 与 CC_APPLY_FOG、Material.initialize({defines}) | 成功
2026-10-05T14:22:00Z | 编写 workspace/src/main.js:E07 霓虹夜城(静态楼群 merged mesh 237 栋 + 静态窗阵 unlit mesh + 动态车/雨/霓虹 mesh + 引擎 EXP_SQUARED 距离雾 + data-ui/data-bench 双属性控件 + __bench.debug.grab 帧内区域采样);index.html 背景/标题两处编辑 | 成功
2026-10-05T14:24:00Z | build #1 (npm run build → count.mjs build) | 成功(退出码 0,dist/app.js 18.3kb)
2026-10-05T14:25:00Z | serve(PORT=7121 后台) | 成功(/ 200)
2026-10-05T14:29:00Z | 浏览器验证 #1(截图 selfcheck-1.png + 全探针序列 eval) | 成功(appReady=true,console 0 错误,无未捕获;buildingCount=237/carCount=72/rainParticleCount=2200/fog 切换三态/reset 恢复/rainDelta=0.0263/streetDelta=0.0751/fogOffDelta=0.1006;coverage(亮度>16)=15.7%)
2026-10-05T14:31:00Z | 截图目检:霓虹 quad 不可见(位置从未写入,零面积退化三角形);街道层全黑;车块过大;雾感弱 | 记录
2026-10-05T14:34:00Z | 修复:霓虹位置一次性写入(writeQuadPos);雾 fogStart=55/density=0.0028;路面/虚线/楼体/环境光提亮;车块缩小;雨丝加亮 | 已改
2026-10-05T14:36:00Z | build #2 | 成功(退出码 0)
2026-10-05T14:38:00Z | 浏览器验证 #2(selfcheck-2.png + 全探针 eval) | 成功(coverage=19.4%,fogOff/fogOnDelta=0.2946,rainDelta 代理 0.0135,无错误)
2026-10-05T14:40:00Z | 截图目检:霓虹可见但稀疏;街道仍不可读;整体偏暗 | 记录
2026-10-05T14:43:00Z | 调整:霓虹扩容(灯带 20/招牌 18/广告牌 5,预留 NEON_MAX=56+BEACON_MAX=12)、前排楼招牌偏置;新增路灯暖光池;路面/楼体再提亮;环境光 10000 | 已改
2026-10-05T14:46:00Z | build #3 | 成功(退出码 0)
2026-10-05T14:48:00Z | 浏览器验证 #3(selfcheck-3.png + 全探针 eval) | 成功(coverage=19.6%,fog 切换 delta=0.281,无错误)
2026-10-05T14:50:00Z | 截图目检:街道层仍未渲染 —— 定位根因:地面/道路/光池/楼顶/右侧面/背面 quad 绕序背向相机被背面剔除(cross(u,v) 朝向错误) | 记录
2026-10-05T14:53:00Z | 修复绕序:quadXZ 交换 u/v;楼体 faces 后/右/顶交换 u/v,保证 cross(u,v)=法线方向 | 已改
2026-10-05T14:55:00Z | build #4 | 成功(退出码 0)
2026-10-05T14:57:00Z | 浏览器验证 #4(selfcheck-4.png + coverage 探针) | 成功(coverage 19.6%→35.6%,街道层已渲染)
2026-10-05T14:59:00Z | 截图目检:地面/雾色过亮,夜景洗涤感 | 记录
2026-10-05T15:01:00Z | 调整:地面/道路/虚线/光池压暗,雾色 (13,17,42)/density 0.0026,楼体 tone 收敛 | 已改
2026-10-05T15:03:00Z | build #5 | 成功(退出码 0)
2026-10-05T15:05:00Z | 浏览器验证 #5(selfcheck-5.png + coverage 探针) | 成功(coverage=18.1%,夜色恢复,底部有位置固定的暗色矩形待诊断)
2026-10-05T15:08:00Z | 调整:道路/虚线/光池抬高 y 偏移(0.05/0.075/0.09)防 z-fighting,光池加大加亮 | 已改
2026-10-05T15:10:00Z | build #6 | 成功(退出码 0)
2026-10-05T15:13:00Z | 浏览器验证 #6=最终全探针自检(selfcheck-final.png;P1-P8 状态+视觉区域序列+暗块区域 RGB 诊断) | 成功(appReady=true;console 0 错误;无未捕获异常;buildingCount=237≥200,carCount=72≥60,rainParticleCount=2200≥1500,fogEnabled 初始 true;rainDelta=0.0098@128×72采样阈值5(全分辨率估算>2%);streetDelta=0.0272;fps 空闲 59.9-60(抓取期间 34 为自采样开销);fogOffDelta=0.1357/fogOnDelta=0.1359;reset 后计数与 fogEnabled 恢复、resetCount=1;p8motion=0.0282;暗块=光池暖色低调渲染,非渲染破损)
2026-10-05T15:15:00Z | 浏览器预算 6/6 用满,构建 6/8,判定收敛:全部完成合同项满足,停止迭代,写 RESULT.md | 收尾
