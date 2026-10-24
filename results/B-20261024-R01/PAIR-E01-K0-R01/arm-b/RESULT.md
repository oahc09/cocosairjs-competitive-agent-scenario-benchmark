# RESULT — Arm B / PAIR-E01-K0-R01

引擎:`cocosair` · 知识等级:`K0`(含引擎官方技能包 `knowledge/skills/`)· 场景:`E01 深空星系巡航`

交付物:`workspace/src/main.js`(唯一改动文件)+ `workspace/dist/`(build 产物);自检辅助脚本 `selfcheck/pngstats.mjs`、截图 `shots/`。

---

## 1. 实现摘要(逐 probe)

**总体结构**:启动时程序化生成 78,000 颗星(星系盘 72,000 + 远景星层 6,000),分别写入两张**合并静态 Mesh**(每颗星 = 5 顶点小扇形:中心满亮度、四角近黑,插值形成圆形辉光;双绕序索引,不依赖 cull 面),共用一颗 `builtin-unlit` + `USE_VERTEX_COLOR` 材质。每张 Mesh 只有 1 个 submesh → **每帧 1 draw call/层**,旋转只改 Node 变换(CPU 近零)。

- **P1(starCount + 非空画面)**:`starCount = 78000`(72,000 星系 + 6,000 远景,全部为真实提交渲染的星点四边形);全画面亮度 >40/255 的像素占比 9.8%(阈值 2%),中央 80% 区域 13.6%;核球(暖黄白、椭球隆起)与两条对数螺旋臂在截图中可辨。
- **P2(旋转状态 + 运动像素)**:星系绕盘面法线(+Y)以 0.05 rad/s 刚性慢旋,`rotationPhase` 由 0 单调递增,2s 增量约 0.10 rad(阈值 0.001);页内帧抓取 1.2s 差异像素 10.1%(阈值 0.5%),运动来自星点切向流动。
- **P3(视差状态 + 像素变化)**:window 捕获阶段监听 `pointermove`(规避 pal 吞 canvas 事件),归一化到 [-1,1] 后做指数平滑;指针 (0.50,0.50)→(0.68,0.50) 后状态 `{0,0}`→`{0.356,0}`,帧差异 23.8%(阈值 0.3%);相机横向偏移 ≤5.5% 距离,远小于画布 10%。
- **P4(滚轮穿行 + 构图变化)**:window 捕获 `wheel`(`passive:false`)把目标距离按 deltaY×0.08 更新并 clamp 到 [40,400],实际距离逐帧指数插值(无瞬跳);deltaY=-600 后 500ms 内 120→72.65(阈值 <115),帧差异 46.1%(阈值 1%),星点放大变疏。
- **P5(HUD 可见 + 数据一致)**:DOM HUD(左下角)实时显示 `STARS 78000 / FPS 60 / DIST 120` 与 `Reset` 按钮,`hudVisible=true`,`fps>0`,DOM 文本数字与 `__bench.getState()` 四舍五入一致;HUD 包围盒亮像素占比 21.0%。
- **P6(帧率)**:最近 2s 滚动平均(基于 `EVENT_AFTER_DRAW` 时间戳)fps=60.0(阈值 30),空闲与交互(reset/滚轮/视差)期间均维持 60,全程 0 console error / 0 uncaught。
- **P7(Reset)**:HUD 内 `Reset` 按钮(`data-ui=reset`、aria-label `reset`)点击后 `epoch+1`、距离插值回 120(800ms 时 119.95)、`parallaxOffset={0,0}`、`rotationPhase` 重置后 0.041(<0.1);画面仍非空(亮像素 11.3%),URL 未变、无整页刷新;连续第二次 reset 同样成立(epoch=2、dist≈120)。

其余规格对齐:星点颜色沿半径梯度(核心暖黄白 → 旋臂蓝白 → 外缘冷蓝)并散布约 4% 橙红亮星;亮度分三档(核球亮星 / 盘面普通星 / 暗弱远景星);盘面有厚度(高斯垂直散布)且核球呈椭球隆起;背景为近纯黑 `Color(5,7,14)`;初始视角俯仰 42°(合同 30–60°),盘面约 68% 画面宽度;全部几何程序化生成,无任何外部图片/模型/预烘焙资源。

## 2. 自检清单(§5)

- [x] `npm run build` 在 `workspace/` 根执行退出码 0(共 6 次构建全部成功,最后一次 build #6)。
- [x] 页面 10s 内 `window.__appReady === true`(verify-browser 首次轮询即 ready,首帧后置位)。
- [x] `window.__bench = { getState(): object, reset(): void }` 契约成立(verify-browser `benchReady: true`;7 个状态字段齐全)。
- [x] 无未捕获异常(6 次浏览器会话 `consoleErrors: 0`、`uncaught: []`)。
- [x] 探针逐条自检通过:P1–P7 的状态断言与视觉断言均在页内实测(状态采样 + 帧抓取像素差/亮像素比 + 截图人工复核),数据见 WORKLOG 13:38:51 行。

## 3. 合规声明(§4)

逐条声明未访问/未实施以下禁止项:

1. 未访问另一 Arm 的任何目录、代码、日志、server、profile、截图、结果。
2. 未访问 `reference/`(Reference 实现、截图、视频、私有验证器)。
3. 未访问 `results/` 下本 Pair 本 Arm 之外的任何目录与既往 trial 结果。
4. 未访问 `harness/` 源码与合同模板。
5. 未访问引擎资产 `bench/vendor/` 整目录,未访问 `E:\AIProMax\github\cocosair.js` 与 three.js r186 源码树。
6. 未访问实验计划书与 `bench/docs/`。
7. 未访问 `secret/`。
8. 未发起任何网络请求(页面/静态资源均来自本机 127.0.0.1:7101 与本地文件)。
9. 未执行 `npm install`、未安装或改动任何依赖,未改动共享 node_modules。
10. 未修改 `brief.md`、`spec.json`、`RUN-CONTRACT.md`、模板脚本(`scripts/*`)、探针或验证代码。
11. 未探测或篡改 harness/validator 行为与期望值;浏览器验证一律经 `scripts/verify-browser.mjs`(计数自动),dev server 使用 `PORT=7101`。
12. 未手改/伪造/删除/重置 `workspace/.budget/*.count`;build/browser 均经 `count.mjs` 计数(build 6、browser 6)。

补充披露(均为白名单内行为):为确认着色器宏/顶点属性契约,曾读取**本 Arm `workspace/dist/vendor/cocosair.module.js`**(模板自带的已构建引擎产物,属 §3 `workspace/` 白名单),未读取任何 vendor SDK 目录或源码仓库;自检辅助脚本 `selfcheck/pngstats.mjs` 与截图目录 `shots/` 均在本 Arm 目录内自建。
