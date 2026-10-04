# QA-02 MQTT / REST 契约测试套件

依据：[任务清单 QA-02](../管理后台开发任务清单.md#qa-02-建立-mqttrest-契约测试套件)。覆盖 CT-03 的 11 类 MQTT、CT-05 的错误码/完整响应，以及当前全部设备 REST API。API 范围通过生产路由与 OpenAPI 自动双向比较，不把管理端所有 operation 混入设备验收分母。

## 运行

先安装仓库依赖；使用 Node 24.12。PGlite 测试使用本地内存数据库及全部 migration。`pnpm verify` 自动生成 Prisma Client、构建依赖包并执行本套件。如果近期修改 Prisma Schema，单独运行套件前先生成 Client：

```sh
pnpm --filter @fdp/database generate
pnpm test:device-contracts /tmp/qa-02-local.json
pnpm verify
```

专用命令执行 Schema/兼容性/变异探针，再执行真实 Handler 测试，最后校验覆盖矩阵。任何测试、契约差异、缺失 operation、声明响应状态未覆盖或缺少合法成功请求都退出 1；通过时退出 0。回执路径所在目录需已存在；失败会写 `status=FAIL` 覆盖原回执，不能沿用旧 PASS。

实现：[CLI](../../scripts/run-contract-suite.mjs)、[REST 校验器](../../contracts/testing/device-contract.ts)、[MQTT 校验器](../../contracts/testing/mqtt-contract.ts)、[兼容性比较](../../scripts/contract-suite/compatibility.mjs)、[变异探针](../../scripts/contract-suite.test.mjs)。

## MQTT 验证

封闭 Topic Catalog 决定验收范围。AJV Draft 2020-12 校验每类的所有合法和非法 Fixture，验证必填字段、类型、枚举、范围、额外字段、组合规则、引用和 format。UTC 日期/时间另外检查真实日历及小时范围，拒绝 2 月 30 日或 24:00。

Telemetry/Report/Tamper 复算 RFC8785 audit hash；ACK 按 DEC-015 检查 COMMAND/OTA_TARGET 必填关联字段与互斥字段。语义检查补充现有 Schema，不修改线协议。每类都带删除 `meta` 和将 `meta.id` 改为 number 的反例；更改 Schema 字段/类型还会触发冻结基线 Gate。

## REST 请求、响应和覆盖统计

`contractHandler` 包装实际业务 Handler：先独立校验原请求，仍让业务 Handler 自己处理，然后校验未剥离 envelope 的完整原始响应，保留 `onCommitted` 回调。包装器只在测试中使用，不在生产响应中插入验证逻辑，不构造替代业务响应。

- 请求：检查正文必填/封闭字段、类型、路径/查询参数与 Header。HTTP 参数允许按 Schema 转换字符串值，JSON 正文严格禁止类型转换。Header 名不区分大小写。Sync 允许首次无正文，Deactivate 强制无正文；CSR 申请/轮询与轮换沿用当前契约。
- 响应：检查 operation/status 是否已声明、完整 JSON/所有嵌套域、响应头必填与值约束、真实日期/URI/UUID 格式。错误 code 必须属于 CT-05 目录且 HTTP status 匹配。
- 307 下载：验证 Location 与 Cache-Control=no-store；OpenAPI 未声明正文，要求实际 Lambda 正文为空。
- 覆盖：各 operation 至少一条结构合法的成功请求和错误响应，且其所有声明响应状态都有实际 Handler 样本。未登记新接口、未覆盖新状态、无有效成功样本和异常 trace 都使 Gate 失败。

测试中的 DB 为 PGlite/真实 migration；IoT、S3 签名和故障端口为本地替身。500、证书包 404/409、并发删除等路径通过真实 Handler 接收注入的依赖故障验证；这证明错误映射与序列化，不代表目标云服务故障已重放。认证签名、RateLimit 和证书/生命周期行为由真实代码执行。

当前全部设备接口：

| operationId | 路径 |
| --- | --- |
| submitOnboardingRequest | POST /api/v1/device/onboarding/request |
| getOnboardingStatus | GET /api/v1/device/onboarding/status |
| getCertificateStatus | GET /api/v1/device/certificate/status |
| rotateCertificate | POST /api/v1/device/certificate/rotate |
| syncDevice | POST /api/v1/device/sync |
| confirmDeactivation | POST /api/v1/device/deactivate |
| redeemOtaDownloadGrant | GET /api/v1/device/ota/targets/{targetId}/download |
| createMediaUploadSession | POST /api/v1/device/media/upload-sessions |

精确测试数、样本数和状态分母见[验收记录](../audit/QA-02-本地验收记录-2026-10-01.md)与[结构化回执](../audit/evidence/qa-02-local-contracts.json)。100% 是本套件全部声明状态/所有实际采样响应符合契约；不表示任意输入、所有业务状态组合或云端行为已穷尽。

## 前一版本与变更治理

[0.11.0 基线](../../contracts/testing/baselines/0.11.0.json)来自 `d93cafb9b2f03ca14a5d3dafc3555e6692cd7232`；[0.12.0 基线](../../contracts/testing/baselines/0.12.0.json)来自 `1af58eede3bde8dfbae7c2012ff7dcdaccfba31b`。两份快照只包含设备 API 的引用展开线协议、11 类 MQTT 与稳定错误码，不包含私钥或生产流量。

MQTT 与前版一致。REST 的 CSR 轮换新增必填 CSR、删除 privateKey、公开证书 chain/双通道状态等是已经批准的破坏性升级，回执标记 `APPROVED_BREAKING_UPGRADE`，不声称旧版完全兼容。精确差异分别关联[旧版审批映射](../../contracts/testing/compatibility-approvals-0.11-to-0.12.json)中的 DEC-026@1.0.0 / DEC-003@1.1.0；这份映射追溯既有冻结决策，不创建新批准。

当前线协议 SHA-256 必须与冻结基线一致；前后快照 hash 必须匹配审批映射；每条破坏性差异必须精确匹配 path/kind、契约版本升级及已冻结的登记版本/history。额外字段删除、类型变更、必填/安全声明/operation/status 删除等都会使 Gate 失败。比较器对未知约束变化采取保守拒绝，不假称完成任意 JSON Schema 的数学包含性证明。

后续合法升级应同时更新协议实现、契约版本、正式决策登记及变更记录，保留前版快照，新增有明确 Git 来源的当前版本快照和精确审批映射，再补服务兼容/迁移测试。不得只刷新测试期望或复制当前 Schema 到前版快照来消除失败。Schema 文案、示例和默认值不进入线协议 hash；治理元数据仍由仓库原决策 Gate 校验。

本次 QA-02 不修改契约版本或决策登记：增加测试与基线，按现有 OTA 契约修正服务的未声明正文。

## 执行边界

不访问生产凭据、不调用真实 AWS、不部署/发布、不推送、不回放生产流量。JSON 回执只保留覆盖计数、状态、决策差异和测试源码 hash，临时 trace 结束清理，不保存证书包、签名或下载 token。目标 AWS/真实 API Gateway 回执仍为 NOT RUN / NO RECEIPT；由后续隔离环境 QA-03/QA-04 获取。

## QA-09 后续协议实现（2026-10-05）

当前基线为 [0.13.0](../../contracts/testing/baselines/0.13.0.json)，由本轮自然生命周期实现提交引入；0.11.0/0.12.0 快照保留。Sync可选许可证确认、完整UTC签名输入及Draft无签名响应遵循既有DOM-01/冻结DEC-020，未重新批准或改写签名算法、许可证权益或业务生命周期。现行[精确变更映射](../../contracts/testing/compatibility-approvals.json)比较0.12.0→0.13.0；oneOf内闭合响应变化和409扩展被保守Gate识别为破坏性升级，不能声称旧固件自动兼容。新确认协议、独立设备验签缺口及回滚影响见[实施手册](QA-09-自然许可证确认与Telemetry阶段观测.md)。
