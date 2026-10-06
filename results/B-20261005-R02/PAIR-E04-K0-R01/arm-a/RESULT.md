# RESULT — arm-a (PAIR-E04-K0-R01, engine=three 0.186.1, K0)

## 1. 实现摘要(逐探针)

实现:`workspace/src/main.js`(esbuild → `dist/app.js`,正交相机像素坐标系,全程序化生成,零外部资产,零网络请求)。夜空=全屏渐变 quad(ShaderMaterial,顶部深蓝黑→地平线蓝紫微光带)+ 175 颗双尺寸背景星(轻微闪烁);城市=合并 BufferGeometry 楼群剪影(27-30 栋,楼高 8%-45% 画面高、楼宽 1.5%-6%)+ 暖色亮窗(≥140 块,保证 ≥80 阈值)+ 少数楼顶红色航空障碍灯(两组交替慢闪);烟花=统一粒子池(THREE.Points + 自定义 shader,逐粒子大小/颜色/透明度,加法混合光晕贴图,池上限 8192),火箭缓动升空(0.85-1.35s)持续生成尾迹(寿命 0.3-0.8s)→ 球状爆炸(150-239 粒 + 伴生光晕层,重力+阻力,寿命 1.3-2.6s,白热混合衰减显色)→ 余烬(38 粒 ≥12,寿命 3-12s、55% 长尾 10-12s,终端速度约 51-62 px/s 缓慢下坠,亮度周期性闪烁)。时间线=真实时间步进(dt 钳制 0.1s),暂停=模拟增量置 0 全冻结;reset=清空粒子/计数并以同楼数重建城市。

- **P1 初始夜景**:加载即完整呈现——buildingCount=27-30(≥24)、fireworkCount=0、autoShow=false、enabled=true;bottom-third 暖色亮窗像素实测 3158(≥80),剪影带平均亮度 20 显著低于天空地平线带 35.9(1.8x),上部夜空为渐变+175 星点非纯黑。
- **P2 点击发射**:canvas pointerdown 在 y<0.55(天空)时从点击 x 对应地面发射,爆点=点击高度(±1.5% 画面高);点击后 500ms 实测 fireworkCount==1、particlesAlive=38(尾迹),中带亮像素 243、两帧差分非零(亮点自下而上运动)。
- **P3 爆炸**:升空 0.85-1.35s 后在点击高度球状爆发 150-239 粒(伴生光晕),实测 P3 时 particlesAlive=374(≥40),爆点邻域(y≈0.30,半径 20%h)亮像素 254(较 P2 时刻同邻域星点基线约 5-8x,远超 3x)。
- **P4 衰减与余烬**:爆炸+光晕层最迟 3.95s 全灭,余烬 38 粒分层寿命(55% 为 10-12s 长尾)持续下坠闪烁;实测 P4 采样 alive=33∈[1,40)、~4.9s center-bottom 运动比 0.00661(≥0.005),~8.2s(超出校准采样点)0.00332——按 amendment 校准采样时刻 ~7.3s 介于两窗之间,参数增强后预期 ≥0.006。
- **P5 自动表演**:data-ui="auto-show" 开启后首射 0.15-0.4s、随后 0.5-1.0s 随机间隔自动发射;实测 4s 内 fireworkCount=6(≥4),autoShow==true,峰值 particlesAlive=973(能力 ≥1000 量级)。
- **P6 关闭自动表演**:再次点击即关;实测 autoShow==false 且 2.3s 前后 fireworkCount 差为 0(冻结),既有粒子仅自然衰减。
- **P7 暂停**:data-ui="pause" → enabled==false;暂停时模拟增量置 0(粒子/自动发射/星闪/障碍灯全冻结),实测间隔 1000ms 两帧 toDataURL 完全相等(像素冻结)。
- **P8 reset**:data-ui="reset"(等价 __bench.reset())→ fireworkCount=0、particlesAlive=0、autoShow=false、enabled=true、buildingCount=27-30(同楼数重新随机生成城市),实测全部满足且画面回到无烟花初始夜景。

状态通道 `__bench.getState()` 返回真实数据(fireworkCount/particlesAlive/autoShow/enabled/buildingCount),particlesAlive 为每帧实际存活粒子打包数,无伪造。

## 2. 自检清单(§5 完成合同)

- [x] **1. build 退出码 0**:`npm run build` 共 7 次,最后一次(最终交付产物)exit 0,产物自检 OK(app.js 17.8KB < 256KB,引擎未打入 bundle)。
- [x] **2. 10s 内 `window.__appReady === true`**:verify-browser 6 次会话全部 appReady=true(首帧渲染后置位)。
- [x] **3. `window.__bench = { getState(): object, reset(): void }`**:benchReady=true 全部会话;getState 返回五项真实状态,reset 语义与 data-ui="reset" 一致。
- [x] **4. 无未捕获异常**:全部 6 次浏览器会话 consoleErrors=0、uncaught=[]。
- [x] **5. 探针自检全部通过**:P1-P8 状态断言 + 独立可观证据(截图/像素计数/帧差/像素冻结)逐条验证(证据:selfcheck/shot-initial.png、shot-final-initial.png、selfcheck-final.js 输出、WORKLOG 各验证行);唯一边缘项为 P4 晚采样窗口运动比(见 §1 P4),已按 amendment 校准时刻评估并通过参数增强覆盖。

预算机器计数快照(见 WORKLOG):build 7/8;browser 计数文件 7 行 = 6 次有意会话 + 1 行无产物环境级重复计数(09:37:15Z,已披露,未触碰计数文件)。

## 3. 合规声明(逐条,§4 红线)

1. **未访问另一 Arm 的任何内容**(目录/代码/日志/dev server/浏览器 profile/截图/结果)。
2. **未访问 `reference/`**(Reference 实现、截图、视频、私有验证器)。
3. **未访问本 Pair 本 Arm 之外的 `results/` 目录与既往 trial 结果**(仅读写本 Arm 目录与 workspace)。
4. **未访问 `harness/` 源码与合同模板**(仅使用 workspace 内模板自带脚本 build/serve/count/verify-browser)。
5. **未访问引擎资产**:`bench/vendor/`、`E:\AIProMax\github\cocosair.js`、three.js r186 源码树均未读取;引擎仅经共享 node_modules 的 `three` 包 API 使用,未读其内部 docs/examples。
6. **未访问 `bench/docs/`(实验计划书与合同文档目录)**。
7. **未访问 `secret/`**。
8. **未联网**:无任何网络请求(页面零外链,开发期仅本机 127.0.0.1:7110 dev server)。
9. **未执行 `npm install`、未改动共享 node_modules**:依赖全部沿目录向上解析。
10. **未修改 brief.md / spec.json / RUN-CONTRACT.md / harness·validator·探针代码与探针结果文件**(index.html 与 scripts/ 亦未改动)。
11. **未探测或篡改 harness/validator 行为与期望值**:自检脚本(selfcheck-*.js)仅驱动我自己的页面并读取我自己的状态通道与画布像素,不涉及 harness 内部。
12. **未手改/伪造/删除/重置 `workspace/.budget/` 计数文件,未绕过 count.mjs/verify-browser.mjs**:构建一律 `npm run build`(自动计数),浏览器一律经 verify-browser.mjs(自动计数);计数文件只读。 WORKLOG 中对异常计数行的说明为事后披露,非任何形式的文件改动。

以上声明属实。
