# 设备图片 P0 与 G0 验收记录

2026-11-06，本批完成 IMG-01 至 IMG-04，G0 为 PASS。该结论覆盖决策、策略、契约、迁移设计、设备样例和本地参考模型。初始分支 main，工作区干净，源基线 8b9ac638。本批按用户指令创建本地提交，推送由用户后续安排。

## 逐项交付

| 任务 | 结果 | 修改与证据 |
|---|---|---|
| IMG-01 | PASS | DEC-009@2.0.0，登记 1.38.0，摄像头策略 JSON/Schema/TS 及测试同步。liveImage 参数独立于既有归档刷新，设备本地显式开启且云端设备白名单准入，默认关闭。消费者追踪为新预览按钮关联 IMG-14，旧媒体接口可继续使用 |
| IMG-02 | PASS | 契约包 0.16.0，五个预览路由标记 planned，错误码局限于声明它们的 operation。triggerRef、200 重用、409 已登记及 evidenceImage 已入 Schema。旧上传请求、旧响应同时通过前后基线。生成 image-types.ts，更新 bundle 和兼容性基线，旧 MQTT 生成物未变 |
| IMG-03 | PASS | 选择单区域 DynamoDB，定义 CONTROL/FRAME/DEDUP、revision CAS、授权 epoch 及事务边界。8 项参考模型测试覆盖六种释放与上传交错、多查看者、帧乱序、授权撤销、租户变更、帧过期、去重与限频。实际适配器及分布式语义另验 |
| IMG-04 | PASS | 给出 MediaTrigger、可空 session 引用、不可变申报、唯一约束、关联状态与历史兼容迁移设计。提交真实 JPEG、Base64、checksum、请求响应及正负样例，提供 S3 签名 Header 要求与设备调用顺序 |

[决策升级](../../contracts/decisions/changes/DEC-009-upgrade-2.0.0.md)、[预览 OpenAPI](../../contracts/rest/live-image-api.json)、[上传会话](../../contracts/rest/device-media-api.json)、[告警事件查询](../../contracts/rest/admin-alarm-api.json)、[类型生成器](../../scripts/generate-image-contract-types.mjs)、[并发设计](../dev/IMG-03-图片预览临时存储与并发设计.md)、[迁移设计](../dev/IMG-04-图片触发引用迁移设计.md)、[设备对接包](../api/device-image-device-package.md)。

REST 文件的决策登记版本统一更新到 1.38.0，涉及既有片段的元数据及重新生成的 bundle。0.15.0 与更早快照保持原内容，保存 0.15.0 原批准记录并新建 0.16.0 快照。保守兼容检查记录 8 条精确变化，包括封闭响应新增字段及 409 结构改为 union，均绑定本次明确批准的 DEC-009@2.0.0。新能力客户端应采用新契约，旧请求仍按既有字段响应。

## 最终检查

本机 Node 24.22.1、pnpm 10.20.0。初始无 workspace node_modules，通过离线 frozen-lockfile 安装已有缓存依赖，锁文件未变。pnpm 命令使用 /opt/homebrew/bin/pnpm。

| 检查 | 结果 |
|---|---|
| pnpm --filter @fdp/contracts test | PASS，319/319 |
| 决策、bundle、消费者追踪、契约基线四组 scripts 专项测试 | PASS，62/62 |
| pnpm --filter @fdp/contracts typecheck | PASS |
| pnpm openapi:check | PASS，全部 REST 片段与统一 bundle 校验 |
| check-decisions、check-schemas、check-prototype-traceability | PASS，无未决决策、无悬空契约及消费者引用 |
| check-delivered-runtime | PASS，129 个已交付操作与路由一致，新预览仍 planned |
| image-types 与 MQTT payloads 生成新鲜度 | PASS |
| 变更 TS/MJS 的定向 ESLint 与新策略、契约、样例的 Prettier | PASS |
| check-secrets、check-boundaries | PASS，敏感信息与模块边界检查 |
| git diff --check | PASS |
| JPEG sips 解码尺寸及二进制/Base64/Hash/size 校验 | PASS，16×16，机器样例可复算 |

复现专项测试使用以下命令。

```bash
node --import tsx --test scripts/check-decisions.test.mjs scripts/build-openapi.test.mjs scripts/check-prototype-traceability.test.mjs scripts/contract-suite.test.mjs
node scripts/generate-image-contract-types.mjs --check
node scripts/generate-payload-types.mjs --check
node scripts/check-decisions.mjs
node scripts/check-schemas.mjs
node scripts/check-prototype-traceability.mjs
node scripts/check-delivered-runtime.mjs
```

## FAIL 历史及未运行项

| 状态 | 现象 | 处理或归属 |
|---|---|---|
| FAIL → PASS | 初版会话响应样例误带 sha256，封闭 Schema 拒绝 | 已移除响应额外字段，保留请求 Hash，样例通过 |
| FAIL → PASS | 新 IMG 消费者未纳入旧策略消费者测试遍历 | 已加入 liveImage 策略，验证所有阻塞任务均有承接 |
| FAIL → PASS | Ajv 默认导入与 TS 模块类型不兼容 | 改用仓库现有 createAjv，保留 UTC 与 UUID 格式验证 |
| FAIL → PASS | 消费者按钮从 Reject 改 Adapt 时缺 source.taskId，旧测试仍要求拒绝类别 | 补 IMG-14 来源，测试明确适配图片预览并保留其他拒绝项验证 |
| FAIL → PASS | 专项测试首次漏用 tsx，及新测试误用无参 DeviceContract 构造 | 按仓库入口带 tsx，复用正常契约验证器实例，最终通过 |
| NOT_RUN | 全量 pnpm verify、业务后端、页面 E2E、实际迁移与 CDK 新资源验证 | 本批契约和模型范围，按后续功能阶段执行 |
| NOT_RUN | DynamoDB SDK 请求、真实事务条件、跨数据库锁、TTL 回收与容量 | IMG-05 至 IMG-08 适配及 IMG-21/23 目标证据 |
| NOT_RUN | 云部署、真实 S3 签名、mTLS 新路由、设备真机与性能 | IMG-21 至 IMG-24 |
| BLOCKED | P0 当前无阻塞项 | G0 已满足，后续输入保持 OPEN |

## 实施细化与下一批依赖

本批增加了单设备最多 16 个同时查看者的策略边界，超出新租约返回 429。原查询辅助函数继续描述归档入口，新 liveImage 策略供后续预览消费。服务端白名单暂采用部署配置方案，P0 只定义其准入语义。

IMG-05 至 IMG-08 可立即开展。实现前需把本地原子模型映射到实际存储端口，约定条件失败、限流及超时重试，并让生命周期、分配及权限撤销写入口参与共享锁和 epoch 失效协议。DynamoDB 与 PostgreSQL 无跨服务原子事务，本地模型不能代替这些入口的实际接线验证。

设备拍照白名单、软件版本及本地能力配置、启用台数和同时查看数、首帧等待目标保持 OPEN，负责人和需要时点在设备对接包列明。它们不阻塞 IMG-05 的租约实现，容量参数影响最终部署选型和验收。

下一可执行任务为 IMG-05，先定义共享存储端口和多查看者租约的条件提交，再实现申请、续租、释放与设备 state 查询，并用 P0 并发用例做适配器等价验证。
