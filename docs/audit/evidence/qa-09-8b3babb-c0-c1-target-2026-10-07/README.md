# 8b3babb QA-09回执索引

[完整报告](../../QA-09-8b3babb默认关闭与C0-C1目标复验-2026-10-07.md)。目标C0闭合，C1部署前CI失败；测试隔离修复已本地验证，尚未发布。

- push/default-off-gate.json：默认关闭输入、实际配置、19 ZIP。
- c0/unit-completion.json：123业务/55阶段/12入口负向及独立清理。
- c0/connection-budget-gate.json：32个一分钟样本最大16，采样边界明确。
- c1/predeploy-failure-gate.json：真实C1输入、AWS步骤SKIPPED、四项本地复现失败。
- restore/no-change-gate.json：失败后19配置不变，实际false；无需恢复部署。
- local-verify/summary.json：测试修复文件hash、C1环境完整verify及七个本轮新Gate。
- manifest.json：本轮文件hash。seal-evidence.py可在仓库根目录复核绑定。

C1没有业务前缀；capacity-before仅现有Worker固定只读查询。原始日志字节不重排，*.log的Git diff按二进制处理，文件可直接打开阅读。seal输出/退出日志与manifest自身不纳入manifest，避免循环哈希。
