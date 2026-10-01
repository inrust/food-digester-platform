# QA-03 IoT 数据链路集成测试

依据[开发任务清单](../管理后台开发任务清单.md#qa-03-建立-iot-数据链路集成测试)，前置为 BE-IOT-02～08、BE-ARC-02、QA-01。套件提供隔离、可重跑的本地链路集成验证。目标 AWS Gate 独立执行；本地回执不能用于替代 AWS 回执。

## 执行

```sh
pnpm test:iot-integration /tmp/qa03-local.json
node --test scripts/iot-integration.test.mjs
pnpm verify
pnpm check:aws-iot-evidence
```

第一条也可使用 `node --import tsx scripts/run-iot-integration.mjs /tmp/qa03-local.json`。CLI 必须提供输出路径；成功输出 LOCAL_INTEGRATION 回执，测试、覆盖或源码稳定性检查失败则覆盖输出为 FAIL 并非零退出。`verify` 已纳入此本地 Gate。正常 CI 不执行需要目标凭据的操作。

## 链路与断言

[夹具](../../apps/ingestion-worker/test/qa03-fixture.ts)使用 QA-01 SimulatedDevice 生成 CT-03 上行消息，构造与 IoT Rule SELECT 字段一致的 envelope，交给真实 `createIngestionHandler` 与 `createBusinessDispatcher`。PGlite 应用全部迁移，执行真实 PostgreSQL 事务、receipt、业务记录和 Outbox。真实租约 Publisher 发送 Archive 消息，真实 Archive SQS Handler / Worker 写入内存对象存储。

IoT Rule、SQS、RDS 服务连接及 S3 网络调用由本地端口模型替代；本套件不验证 AWS 的 Policy、服务投递、Error Action、IAM、DLQ、网络或生产恢复。Media 使用独立上传会话和内存存储端口，不进入 MQTT_RAW；Heartbeat 更新状态并保留 receipt，不归档。

[集成场景](../../apps/ingestion-worker/test/qa03-data-path.test.ts)覆盖：

| 场景 | 验证 |
| --- | --- |
| 八类上行、多设备、重复重投 | 各类型实际业务结果、receipt、Outbox；重复后行数与聚合不增加；ACK 状态变化 |
| Quarantine 与 partial failure | 非法 JSON、Schema、证书身份、同键异内容；Quarantine 投递失败与瞬时分发错误只返回当前 SQS ID |
| 序号缺口 | seq=1/3 入库、seq=2 瞬时失败形成缺口；只重投失败项后解除缺口 |
| Archive 故障 | 单条发送失败留在 PENDING 并记录重试；Manifest 写失败返回可重试 ID；重投后稳定对象收敛；非法 Archive JSON 不阻塞合法记录 |
| 事务回滚 | PostgreSQL trigger 拒绝 Outbox INSERT；业务、receipt、Outbox 全部回滚；移除注入后原消息成功 |
| 原文一致性 | 解压 NDJSON 原文逐字符等于输入 envelope；Payload 相等、audit hash 可重算；Manifest SHA-256 与实际 GZIP 字节一致；重复/反序归档保持同 Key 同字节 |
| 清理 | 成功、场景抛错、夹具初始化失败都关闭数据库；清空队列/对象；再次清理幂等 |

每个场景单独创建 PGlite 和 `QA03-<随机标识>` customer/device/证书/命令/Media 会话前缀，互不依赖执行顺序。失败清理场景还验证关闭后 SQL 不可执行。内存数据库关闭即销毁全部数据，清理不操作共享数据库、生产资源或 DLQ。

## 证据与 Gate

[运行器](../../scripts/run-iot-integration.mjs)从新建临时 trace 读取成功场景（仅清理完成后记录），强制校验路由、数据守恒、重复为零、原文 Hash、故障覆盖及唯一隔离前缀。失败场景不能写成功 trace，临时目录在 finally 删除。[Gate 反例](../../scripts/iot-integration.test.mjs)验证缺场景、清理失败、隔离前缀复用、丢消息、业务重复、缺原文证明和缺故障探针均失败关闭。

回执记录时间、提交前 baselineCommit 与相关源码/迁移/契约/依赖文件 SHA-256；运行前后源码发生变化则失败。Git 提交后的复验应输出新文件，历史回执保留当次源码 Hash，不能将 baselineCommit 宣称为最终提交。

目标 AWS 使用既有[证据 Gate](../../scripts/check-aws-iot-data-path-evidence.mjs)和[采集说明](../audit/evidence/BE-IOT-AWS数据链路证据采集说明.md)。必须使用隔离测试环境、exact-HEAD 回执、真实路由/原文/故障和清理证据。没有此回执时，AWS Gate 为 **NOT RUN / NO RECEIPT**，QA-03 的 AWS 全链路验收保持 **CONDITIONAL / NOT ACCEPTED**。

本次[验收记录](../audit/QA-03-本地验收记录-2026-10-01.md)保存精确测试快照。
