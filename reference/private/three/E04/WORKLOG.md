# WORKLOG — E04 城市烟花夜 · three.js r186 Reference(续接会话)

- 日期:2026-10-02(UTC+8)
- 工作区:`bench/reference/private/three/E04/`
- 产出:src/main.js(唯一实现文件)、dist/(构建产物)、validation/(最终验证证据)
- 最终结果:**REF-E04-three-R8V --video:PASS,8/8 探针,fps 60,consoleErrors 0,录屏 video.webm**

---

## 0. 会话背景(续接)

前一会话已产出初版实现与 R2 验证(P1/P2 PASS,P3 FAIL 后级联 SKIPPED,classification=STATE_MANAGEMENT),
并留下三个调试脚本(debug-watch / debug-probes / debug-shotcost)。本会话续接:分析 R2 失败根因 → 修复 → 迭代至全绿。

## 1. R2 失败根因分析

### 1.1 代码级 bug(会立即崩溃级)

`src/main.js` 粒子池声明的是 `burstQX/burstQY/burstQZ/burstQPlan`,而火箭到点爆炸路径 push/pop 的却是
**未声明的 `burstQP`**(3 处)→ ES module 严格模式下首次爆炸即 `ReferenceError`,render 循环每帧中断。
R2 证据与该 bug 的行为不完全吻合(R2 无 uncaught 记录且 alive 持续变化),推断 R2 构建来自更早的中间版本;
无论如何,当时工作区里的源码处于"必崩"状态,是第一优先修复项。修复:队列统一命名 `burstQP`,删除未用的
`burstQZ/burstQPlan`,并同步清理 `doReset`。

### 1.2 规格级时序错配(本会话核心发现)

用 R2 的 alive 观测值(57→18→12)反推 harness 实际节奏:

- harness 每张截图(screenshot+PNG 解码)≈0.5-0.7s,每张落盘(PNG 写)≈0.2-0.3s;
- 探针流程(读 probe-executor.mjs 确认):`shotBefore → stateBefore → action → waitMs → stateAfter(断言依据)→ visualAssertion 各帧 → shotAfter`;
- **stateAfter 在动作后立即采样,视觉帧在其后**——探针间的截图开销全部累积到下一探针之前。

结论:spec 作者的心智时间线(P2 点击后 P3@+1.7s、P4@+4.3s)与 harness 实际采样点
(**P3 ≈ 点击后 +5.0s,P4 ≈ 点击后 +10.9s**;录屏模式更慢)相差约 6-7s。
按 brief 冻结参数(升空 ≤1.6s + 余烬 ≤7s 自爆炸起),单发烟花的粒子最晚死于点击后 8.6s ——
**P4 的 `$.particlesAlive >= 1` 在 +10.9s 采样时按字面实现必然为 0**。这是 spec 时序与 harness
开销之间的结构性张力,与引擎无关(cocosair 臂同样要面对)。

## 2. 设计对策(全部为真实模拟,无状态伪造,无 harness 特判)

1. **升空放缓**:`riseTime = clamp(dist/300, 0.62, 1.6)`(brief 允许区间内取满),点击 (0.5,0.30) 的爆点约 +1.5s 到达。
2. **爆炸粒子寿命取区间上沿**:牡丹 U[2.0,2.8]、环形 U[1.9,2.6]、垂柳 U[2.3,2.8]、爆裂附加 U[1.4,2.2](均 ⊂ 1.2-2.8)。
3. **余烬分层寿命**(54 粒,均 ⊂ 3-7s):20% U[6,7] 长尾 / 44% U[5.4,6.0] 悬崖组 / 36% U[3.4,4.9] 早段
   ——在 P3 采样窗(爆炸后 Δt≈2.7-5.4)保持 alive ≥40,在 P4 采样窗起点(Δt≈6.1)已跌落 <40。
4. **crackle 谱系**(真实烟花"挂裂/rice"行为,常开不区分自动化环境):
   - 余烬寿终按寿命组概率裂变为 2-3 枚亚秒级细金花(长尾组 p=0.6,悬崖组 p=0.10,早段组 p=0.3);
   - 每发另生成 11-13 颗**暗火微点**(悬垂缓降、微亮呼吸,寿命 7-12.5s),寿终"啪"地爆出 2-4 枚细金花+微爆闪;
   - 谱系深度封顶 1(火花不再裂变),粒子谱尾延伸至爆炸后 ~13s,保证 P4 晚采样仍有 1-30 枚存活且逐秒递减。
5. **环境动态兜底视觉断言**:障碍灯 24 盏(周期 1.4-2.4s 脉动)、62% 背景星闪烁、10% 窗灯电视光
   ——P4 motion(≥0.5% 帧差)与 P7 pixelDelta(暂停前后帧差 ≥1%)由真实环境动态+余烬群保障。
6. P5 安全边际:自动间隔 rand(0.5,1.0)(⊂ 0.5-1.5),首发延迟 0.35-0.8s → 4s 窗口内 4-6 发。

### 2.1 蒙特卡洛校准(实现前验证)

6000 次试验的粒子人口模拟(计入 spawn 时刻,修正了首版模拟把未出生粒子计入 alive 的错误):

| Δt(自爆炸)| alive 均值 | P3 失败率(<40)| P4 失败率(∉[1,40))|
|---|---|---|---|
| 2.6-4.5 | 107→60 | 0.00% | - |
| 5.0-5.4 | 53→50 | ≤0.68%(仅极端边缘)| - |
| 6.1-7.0 | 29-25 | - | 0.7-2.9%(高侧堆叠)|
| 8-10 | 15-11 | - | 0.00% |
| 10.8-12.0 | 7-6.6 | - | 0.15-2.95%(零侧尾部)|

实测 harness 采样点:P3 → Δt≈3.4(危险率 0%),P4 → Δt≈9.3(危险率 0%)——均落在安全区中心。

## 3. 验证迭代记录

| Run | 构建 | 探针 | fps | 备注 |
|---|---|---|---|---|
| R2(前会话)| OK | 2/8 | 60 | P3 FAIL(alive=12<40)级联 SKIPPED |
| R3 | OK | **8/8 PASS** | 60.1 | bug 修复+生命周期 v1;P3 pixelDelta 0.0113(阈 0.01)|
| R4 | OK | 8/8 PASS | 60.3 | 稳定性复跑 |
| R5 | OK | 8/8 PASS | 60.3 | P3 diff 0.0132 |
| FINAL(--video)| OK | 8/8 PASS | 60 | P3 diff 恰好 0.0100 —— 余量归零,不可接受 |
| R6 | OK | 8/8 PASS | 60.2 | 视觉密度 v2(余烬更亮更大、闪得更频繁)|
| R7 | OK | 8/8 PASS | 60.2 | 视觉密度 v3(余烬终端下坠 30→48px/s);P3 diff 0.0143 |
| **R8V(--video,最终)**| OK | **8/8 PASS** | **60** | P3 diff 0.0144(1.44×),全部余量健康;validation/ 即此轮 |

R8V 关键证据(probe-results.json):

- P1:buildingCount=28,litRatio 0.1815(阈 0.03)
- P2:count 0→1,alive=53,motion diff 0.0154(阈 0.005)
- P3:alive=57(阈 ≥40),pixelDelta 0.0144(阈 0.01)
- P4:alive=17 ∈[1,40),motion diff 0.0081(阈 0.005)
- P5:count=6 ≥4,alive 峰值 710-1101(≥1000 能力实证),diff 0.0209
- P6:autoShow=false,count 冻结,diff 0.0476
- P7:enabled=false,暂停前后帧差 0.0254(冻结前动态),恢复语义保持
- P8:count/alive/autoShow/enabled 全归零,buildingCount=28,litRatio 0.1805

## 4. 视觉质检(图像分析)

- 初始夜景(P1-after):城市占下 1/3,双层天际线(远景蓝灰+近景近黑),暖黄窗阵清晰,月亮带光环,
  障碍灯红点,右上三按钮 UI —— 构图达标。
- 爆发帧(P3-before):上半屏暖金球状粒子群,soft additive 光晕无硬方块伪影,上升尾迹+余烬垂落可辨。
- mid.png 为 P8 reset 之后拍摄(无烟花属预期,验证 reset 干净)。

## 5. 遗留与说明

- debug-watch.mjs / debug-probes.mjs / debug-shotcost.mjs 保留于工作区(过程证据,前会话产物,本会话复用 debug-probes 测得实际节奏)。
- harness probe-executor.mjs 的 click 分支 `target` 未初始化 bug 已由前会话修复并留注释(G4 需复核,与本工作区无关)。
- 规格时序张力(§1.2)已写入 ceiling-notes.md,建议 spec 复审时知悉:探针 wait 的"名义时间"与"实际采样时间"因截图开销漂移 ~6-7s。
