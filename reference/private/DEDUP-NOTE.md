# node_modules 去重说明(exFAT 约束)

> 2026-10-02 执行,同日升级为**全局共享仓**方案。原因:E: 卷为 **exFAT**,
> 不支持 junction/symlink/hardlink(任何重解析点),无法用链接去重;
> 改用 **Node 向上模块解析** 模式。

## 现行布局(全局唯一共享仓)

```
node_modules                        ← 全局共享仓(esbuild/playwright-core/three/cocosair.js-k0)
templates/{three,cocosair}/node_modules  ← canonical(coordinator --vendored-deps 时才拷贝)
仓库根下一切工作区(reference 20 / pilot 8 臂 / 未来 pair)【无】自有 node_modules
```

`scripts/build.mjs`(模板 + 既有 28 个工作区已同步打补丁)esbuild 解析与引擎文件定位
均**沿目录向上查找** node_modules → 命中 node_modules。
运行时页面零依赖 node_modules(import map → dist/vendor 自包含)。

## 效果与验证

- bench 总占用:**6.9G → 4.7G**(省 2.2G;首轮引擎层方案曾到 6.15G→2.5G,合并后如上)
- 验证:reference 与 pilot 臂各抽样 `npm run build` exit 0;引擎模块 sha256 与冻结值一致
  (`cocosair.module.js = 3ccfdde1…`);门户(7800)与画廊 Reference/Run iframe 均 READY

## 注意

1. **工作区不可单独拷走重建**(离开 仓库根树找不到依赖)——迁移时整树移动。
2. exFAT 上**永远不要**尝试 `mklink /J` 或 `New-Item -ItemType Junction`(报"函数不正确")。
3. 新 pair 由 coordinator 创建时默认即无 node_modules(共享依赖),无需再清理;
   `--vendored-deps` 可选回退为独立拷贝。
4. 依赖版本升级时:先升 templates,再同步合并到 node_modules,并全量重跑各引擎一次 build 冒烟。
