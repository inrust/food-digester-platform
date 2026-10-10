# QA-09 合同公开三窗口离线证据

本轮仅本地测试工具，目标新接线/部署NOT_RUN；QA-09/P95 PARTIAL。

- `baseline-binding.json`：旧0afe483目标822个封存文件复核，原443/137/102ms不追溯拆分；旧传输单独绑定。
- `matrix/`：16个新进程串行、每个45秒、真实Prisma/受控pg、pool1、网络0；每组合保存command/exit/log/receipt，matrix绑定源与回执字节。
- `observations.json`：四业务窗口及全部固定位置对照，只有OBSERVATIONS_ONLY，无真实模型成本后移/收益结论。
- `run-local-checks.py`：复现局部与完整verify等价链路；仅eslint/prettier排除本任务外用户build/。
- `local-checks.json`保留原沙箱FAIL；`remaining-checks.json`记录回环许可下的脚本复验及后续检查，`final-checks.json`记录新增单pool断言后的受影响项复验，`effective-checks.json`合并判定。逐步骤原stdout/stderr/exit均保留。
- `manifest.json`：最终封存文件及源码/文档绑定。目录内新证据不能替代目标19工件、业务/清理或P95。

探针默认关闭且仅测试目录可用。原应用/Infra/workflow/SQL与既有运行时开关不变。实验固定两次显式微任务让步及async包装，不是目标等价链路；未访问compiler私有API，未创建真实数据库或目标夹具。
