# QA-09 b41b45c R0/R1 目标回执

目标源码：`b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e`。本目录仅记录该版本的新前缀验收；此前版本及失败回执保持原样。

`preflight/initial-preflight.json` 是登录刷新前的阻断历史；后续入口以 `preflight/entry-gate.json` 和各单元的实际部署、配置、登录、版本回执为准。辅助文件由历史已审阅源码复制，来源哈希见 `helper-origin.json`，未复制历史目标结果。

顺序：默认关闭同 SHA 与19工件核验 → R0（account candidate=false，detail=true）→ 自身清理与独立空集 → R1（account candidate=true，detail=true）→ 自身清理与独立空集 → 同 SHA 关闭恢复（preconnect/account/detail=false，engine=true）→ 只读预算与空集复核。R0严格阶段失败时不进入R1，先清理并关闭恢复。

固定边界：test、API512MiB/arm64/nodejs24.x/reserved12、pool1、静态63/可用70连接、业务并发不超过6、6基线及12独立采样PATCH；不增加pool/容量，不重放业务，不强制冷启动，不改IAM/KMS，不发送邀请。

五个细分阶段只表示公共ORM/适配器/pg结算边界；pg窗口包含连接等待，CPU为PROCESS_ALL_THREADS。自然冷缺失保留NOT_OBSERVED；完整QA-09、独立设备HMAC/Active、邀请与P95结论分别保留既有边界。

本轮实际进入原始R0清理失败路径。完整R0/R1辅助文件是预备源码，R1没有执行。关闭恢复准入由 `close-failed-r0.py` 生成，最终封存由 `final-check-failed-root.py` 生成；原child/parent、首次补偿顺序错误及采样严格校验失败均保留。最终补偿见 `r0/cleanup-recovery-completion.json`，不得用它覆盖原FAIL或冒充R1准入。

终态核验仅采用 `restore/owned-build-terminal-bounded.json`：buildspec、源码与原始Plan字节三元绑定，13个本轮Build均终态（含保留的提前audit-empty失败）。早期仅源码匹配的清单由 `build-inventory-invalidation.json` 明确作废；后续两个批量读取超时日志保留，不用于Gate。最终采用每批5个、最多4个并发的有界只读读取，没有重跑云端任务。
