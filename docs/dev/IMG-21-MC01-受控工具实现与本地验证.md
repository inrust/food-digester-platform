# IMG-21 MC01 受控工具实现与本地验证

基线 main bbb3c8d8。完成独立工具源码、真实 Writer/Verifier Lambda handler、现有 PG authority 协议接入、audit_logs 原子收据、SDK 端口和本地打包。未改应用业务入口、V1 权限矩阵、数据库 schema/migration、IAM 或 CDK。工具不属于此前 d1a7b811 的应用 G3 认证；应用候选及旧严格准入规则未改。

实现与请求规范见 [tools/img21/README.md](../../tools/img21/README.md)，阶段依据见 [最小补齐方案](../api/device-image-minimal-closure-plan.md)。MC01 本地代码完成，MC02 IaC/实际权限和 MC03 候选绑定仍待执行。

交付文件：tools/img21 中的 contracts.ts、controlled-writer.ts、run-ledger.ts、license-verifier.ts、identity-port.ts、secret-port.ts、runtime.ts、writer-entry.ts、verifier-entry.ts，以及独立 typecheck/test/build 配置。业务与成功收据同事务；操作意图提前持久化；UNKNOWN 不自动重写；提交后恢复失败保留 SUCCESS 和恢复观察。允许状态失效后的自身关闭，不允许跨租户/跨设备清理或孤立账号冒认。

Verifier 另行固定真实 License/version/snapshotEtag：v1 HMAC 不覆盖这些外层元数据，不能只相信调用者输入。Writer manifest 账本固定，后续 Verifier 使用独立配置摘要，MC02 仍须完成短期快照配置与数字版本发布的绑定流程。没有受信 manifest 的本地包默认拒绝，未生成可部署的目标配置。

本地适用检查与 FAIL/BLOCKED/NOT_RUN 见 [result.json](../audit/evidence/2026-11-08-device-image-MC01/result.json)。新增工具测试68项、既有 PG/DynamoDB/五接口鉴权回归36项、执行包回归136项通过；typecheck、lint、格式、边界、证据、敏感信息、实际打包导入与默认关闭检查通过。代码包复算和源摘要随证据保留。完整 pnpm verify、目标原生竞争/IAM/Secret/设备启用/真实 G4 均 NOT_RUN，不将 PGlite 或 SDK mock 记为目标通过。

初次两轮夹具未填写 latestState.customerId，命中既有数据库一致性约束；第二轮 signer 夹具误用小写内部 entitlement，正向 HMAC 对照失败。修正夹具，不弱化数据库约束或 signer。另保留只读夹具属性赋值、负向 Secret ARN 的 TS 过窄推断及 MJS Node 全局 lint 的失败记录；另一次新回归把写请求的 deviceId/expectedAuthEpoch 复制到 READ_OPERATION，被封闭契约正确拒绝；改用最小只读请求后通过。已修复，无未解决本地 FAIL。详见 failed-attempts.json，原日志不覆盖。

当前目标准入沿用已记录的11/22，11项缺失继续 BLOCKED，G4 NOT_RUN；本轮没有新的目标观察或输入。App/真机不属于云端前置。本地未调用真实云端、部署、扩权、迁移目标库、启用设备、传图或推送。

下一可执行任务：MC02，基于本工具实现独立 IaC、本地 synth/权限检查、连接预算、Writer Phase A/B、实际数字版本与两份 manifest/短期快照发布约束；先完成本地设计与检查，再单列目标写操作和授权范围。不能复用旧准备窗口进行部署或 G4。
