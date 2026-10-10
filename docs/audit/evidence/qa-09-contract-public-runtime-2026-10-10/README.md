# QA-09 无强制让步的运行时公开接缝证据

本目录仅保存本地实现、测试、默认关闭接线及同新SHA对照准备；没有AWS部署、业务请求或新目标回执。整体QA-09/P95 PARTIAL。新SHA必须人工GitHub Desktop推送后核对CI/部署及19工件，按R0→原清理→R1→原清理→关闭恢复执行。

- `matrix-final-validated/matrix.json`：最终源码绑定的8个新进程串行矩阵，真实Prisma/adapter+受控pg，不新增强制让步；每个45秒、pool1、网络0。16事务=12commit+4rollback，24checkout/release、8dispose。`matrix/`及`matrix-final/`为先行矩阵，后续强化了trace归属和受控成本落点校验；未覆盖原字节。
- `observations.json`：最终矩阵全部首次/后续窗口、公开子段和操作计数；仅观察，不归因编译器/服务器/网络或P95。
- `local-checks.json`与原日志：专项PASS，lint因本轮测试慢日志空循环缺注释FAIL，修复后重跑；原FAIL保留。
- `remaining-checks.json`：lint/format/typecheck/OpenAPI及应用/契约PASS，脚本3项本机监听被沙箱EPERM拒绝；原FAIL与stdout/stderr保留。
- `loopback-checks.json`：允许本机回环下仅重跑脚本，再继续build、仓库门禁、主E2E及QA02–08；没有重跑已通过的应用/契约全套或执行AWS。
- `final-checks.json`、`late-checks.json`、`effective-checks.json`：最终受影响检查与有效本地结果。不宣称原始pnpm verify命令全绿；用户未跟踪build/仅从eslint/prettier排除。
- `baseline-binding.json`：原0afe483目标822文件及上轮离线208文件重新校验；历史443/137/102ms保持原义，不升级为新阶段验收。
- `manifest.json`：当前文件、源码与文档哈希封存。矩阵、日志、原失败和源证据保留；归属证明使用最终源码重新校验。

新开关默认false，受test/pool1/engine/preconnect/detail约束，仅ApiFn可开；push固定false，两组手动public=true、恢复false。after-queue内部公开compiler接缝仍UNRESOLVED；传输节点独立UNRESOLVED，额外HTTP/MQTT探针0；独立设备验签/自然Active/邀请发送NOT_RUN。不改IAM/KMS/容量，不远程push。
