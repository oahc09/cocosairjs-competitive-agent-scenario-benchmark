# RESULT — PAIR-E04-K0-R02 / arm-b(three · K0)

> Run 结束交付。自检证据:`selfcheck/selfcheck.json` + `selfcheck/p1..p8 *.png`(浏览器口径,build #5);
> 最终产物为 build #6(见 §2 披露)。机器计数:`workspace/.budget/build.count`=6、`browser.count`=6。

## 1. 实现摘要(逐 probe)

实现为 `workspace/src/main.js` 单文件(约 620 行),Three.js r186,正交相机把世界坐标钉在视口标尺上
(视口高=100 世界单位,点击高度与爆点高度运动学精确对齐)。夜空渐变/星点/楼群剪影/亮窗全部程序化生成,
烟花为单一 `THREE.Points` 粒子池(4096 容量,加色混合+片元径向辉光,零外部资产),真实时间步进,
暂停=不推进 simTime 且不重绘(整帧冻结)。

- **P1 初始夜景**:28 栋程序化楼(高度主体 25%-38% 画面高,少量 12%-25%/38%-45% 撑天际线)、洗牌点亮
  ≥90 盏暖黄/暖白糖片式亮窗、170 颗星点、垂直渐变夜空(地平线蓝紫亮带)+4 盏红色障碍灯慢闪。
  实测:warmBottom=11727 像素(阈 80)、skyNonBlack=32735、buildingCount=28、fireworkCount=0、enabled=true。
- **P2 点击发射**:canvas pointerdown(仅夜空区域,UI/城市带不发射)→ 从点击横坐标对应的城市地面附近
  发射火箭头,运动学解算 v0 使起爆高度=点击高度(偏差 0 ≤ ±5%);上升段 ≈130 粒/s 喷出暖金尾迹(寿命 0.3-0.8s)。
  实测:fireworkCount 恰 +1、particlesAlive=60、竖直带两帧差分 491 像素(上升运动)。
- **P3 爆炸**:火箭到达后球面均匀方向撒 120-200 粒(视线向分量调制尺寸增强球感),重力+阻力下坠,
  寿命 1.2-2.5s,尺寸/透明度随寿命衰减。实测:particlesAlive=161-219(阈 ≥40),爆点邻域亮像素 147-298
  (P2 时刻基线 0-5,≥3x)。
- **P4 衰减与余烬**:爆炸粒子先期燃尽 → particlesAlive 只剩余烬(单调下降 161→26→19);余烬 34 粒/发
  (≥12),分层寿命 3-12s(40% 长尾 10-12s,spec v1.0.2 修订),异质终端速度 6-13 单位/s 缓慢下坠+
  双频明灭闪烁。实测:particlesAlive∈[1,40) 且 <P3 峰值;center-bottom 两帧差分比 0.0049-0.0063(阈 0.005,
  早期采样稳定过阈,晚期采样偶贴近阈值——见 §2 披露)。
- **P5 自动表演**:`data-ui="auto-show"` 切换;开启后 0.12-0.3s 首发,随后 0.55-1.0s(⊂spec 0.5-1.5)随机间隔
  随机位置/颜色发射。实测:4s 内 fireworkCount 1→6-7(阈 ≥4),上半屏亮像素脉冲 3-4 次(阈 ≥3)。
- **P6 关闭自动表演**:再次点击即关,发射计时停。实测:autoShow=false,间隔 ≥2s 两次采样 fireworkCount
  差=0;既有粒子仅自然衰减。
- **P7 暂停**:`data-ui="pause"` 切换 enabled;暂停时不推进 simTime 且跳过重绘 → 全画面(烟花/自动发射/
  窗灯/障碍灯/星闪)整帧冻结。实测:enabled=false,间隔 1000ms 两帧差分=0 像素(阈 <0.5%);恢复后从冻结处继续。
- **P8 reset**:`data-ui="reset"` 等价 `__bench.reset()`:清空全部粒子(逐槽 kill)、fireworkCount=0、
  autoShow=false、enabled=true、城市按相同楼数(28)重新随机生成。实测:状态全零+buildingCount=28,
  画面回到无烟花初始夜景(warmBottom=11153,上部亮像素回落至 2)。

## 2. 自检清单(RUN-CONTRACT §5)

- [x] **1. `npm run build` 退出码 0**:6 次构建全部成功(esbuild + 产物自检:app.js/vendor/addons/dist/index.html,
      app.js 20.6KB,引擎保持 external)。
- [x] **2. 10s 内 `window.__appReady === true`**:verify-browser 与每次自检会话均就绪(实际 <1s)。
- [x] **3. `window.__bench = { getState, reset }` 契约成立**:getState 返回
      `{fireworkCount, particlesAlive, autoShow, enabled, buildingCount}`(全部真实数据,禁伪造);
      reset 可调用且语义如上。
- [x] **4. 无未捕获异常**:全部会话 console error=0、pageerror=0。
- [x] **5. 探针自检全部通过**:最终浏览器口径 selfcheck r5 = **9/9 PASS、0 console error**
      (P1-P8 + 附加"reset 后手动发射仍可用")。披露:此后针对 P4 运动余量做了最后一次纯强度调整
      (余烬 30→34、亮度下限、窗灯闪烁幅度;均为单调增强、不动任何时序/状态逻辑,P4 状态上限仍 34<40),
      因 browserAttempt 额度已满 6/6,该最终 build #6 未再开浏览器会话,仅经 esbuild 产物自检 +
      dist/app.js 字面量核验;此前等效配置(build #4/#5)已两次浏览器口径 9/9 通过。

## 3. 合规声明(逐条,RUN-CONTRACT §4)

1. 未访问另一 Arm 的任何目录、代码、日志、dev server、浏览器 profile、截图或结果。
2. 未访问 `reference/` 下任何内容。
3. 未访问本 Pair 本 Arm 之外的 `bench/results/` 目录与一切既往 trial 结果。
4. 未读 `harness/` 源码与合同模板(仅读本 Arm 内的 workspace 模板脚本,属白名单)。
5. 未访问 `bench/vendor/` 引擎资产及两个引擎上游源码仓库;引擎仅经共享 node_modules 的已安装包使用。
6. 未读实验计划书与 `bench/docs/` 合同文档目录。
7. 未访问 `secret/`。
8. 未发起任何联网请求(无文档/搜索/registry 访问;页面运行时零网络依赖,import map 指向本地 vendor)。
9. 未执行 `npm install`、未新增/改动任何依赖,未改动共享 node_modules。
10. 未修改 brief.md、spec.json、RUN-CONTRACT.md、harness/validator/探针代码或探针结果文件。
11. 未探测或篡改 harness/validator 的行为与期望值(自检脚本只读自己的页面与像素,不触碰 harness)。
12. 未手改/伪造/删除/重置 `workspace/.budget/` 计数文件;所有构建经 `npm run build` 串联计数,
    所有浏览器会话(6 次)均经 `verify-browser.mjs` / 自检脚本内的 `count.mjs browser` 先计后会话,无绕过。

—— Arm B(three · K0)Run 完毕,交付于 `results/B-20261006-R01/PAIR-E04-K0-R02/arm-b/`。
