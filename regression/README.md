# regression/ — Cocos AIR 引擎缺陷回归套件

> 目的:把双引擎实验发现的引擎缺陷变成**可自动验证的回归用例**,支撑闭环:
> 实验发现缺陷 → 引擎修复 → 新 tarball → `node run.mjs regression` 全绿 → 下一轮实验对比。

## 运行与验收

```bash
cd 仓库根 && node run.mjs regression          # 跑全部用例(无头 Chrome)
```

- 产出:`regression/report-v<ver>-<sha8>.json` + 版本注册表 `vendor/engine-versions.json`(历史可比)。
- 判定:`FIXED`(行为正确)/ `BUG`(缺陷仍复现)/ `ERROR`(用例自身问题,不计引擎账)。
- **验收口径:目标引擎版本的 BUG 数归零;ERROR 属于测试债,修复用例本身。**

## 基线(v1.0.0-k0, sha ddd5072a,2026-10-03)

| 用例 | 基线 | 说明 |
|---|---|---|
| R-wheel-event-swallow | **BUG** | 引擎 canvas 层 wheel stopPropagation,window 冒泡监听收不到(E01/E05 实测) |
| R-quad-size-ignored | **BUG** | primitives.quad 忽略尺寸选项恒 1×1(E08 实测) |
| R-camera-visibility-default | FIXED | 未显式设置 visibility 的相机可正常渲染 DEFAULT 层 |
| R-gltf-standard-black | FIXED | character.glb 经 GLTFLoader+instantiate 渲染正常(注:Pilot E10 在 K0 模板语境曾现纯黑,与本用例环境存在差异,修复后应保持 FIXED) |
| R-light-color-plain-object | FIXED | 灯色传普通对象会**抛错**(响亮失败,优于静默 NaN;engine 若改为自动转换同样算 FIXED) |
| R-getlocation-poison | FIXED | 事件 API 传普通对象不再毒化分发器 |
| R-pointlist-garbage-triangles | FIXED | 8×8 网格点云 redPixelRatio=0.0119(点状);若被吞成三角形会跳升 ~25× 自动判 BUG |
| R-setproperty-color-array | **ERROR(待调)** | 用例自身 effect JSON 未对齐引擎要求(SETUP: usage null)。**补全方法:整段移植 reference/private/cocosair/E02/src/main.js 的 makeEffectJson/UBO 辅助(约 380-467 行)**;该缺陷(G-NAN-FAMILY,E01/E02 最高频黑屏根因)的回归价值最高,优先补齐 |

## 新增用例

在 `cases/` 加一个自包含 html(参考现有用例 + `lib.mjs` 引导),页面最终 `window.__reg = { done: true, outcome: 'FIXED'|'BUG'|'ERROR', detail }`。
用例应**不依赖光照/unlit 或确定色**,判定阈值留 10× 以上余量。
