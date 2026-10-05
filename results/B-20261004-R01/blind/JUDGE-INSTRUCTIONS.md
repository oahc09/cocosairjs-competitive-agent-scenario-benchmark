# JUDGE-INSTRUCTIONS — 批次 B-20261004-R01

材料:results/B-20261004-R01/blind/CMP-*/{side1,side2}/shot-*.png
主题锚定+一致性验证协议、六维 0-3 评分与 preference 判定,按 docs/metric-spec.md §18;
两个独立 Judge 会话执行后把结果按 <batch>/blind/visual-scores.json 契约回填(pairs[pairId][engine]=Σ18),
然后重跑 --stage aggregate。
