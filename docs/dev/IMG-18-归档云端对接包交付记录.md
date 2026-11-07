# IMG-18 归档云端对接包交付记录

2026-11-07，基于本地提交 `981ec9390b5e409bcc7c7ae3add3b9693e6fc1bd`。进入时 main 工作区干净，已有 14 个未推送提交。根 AGENTS.md 已检查，按用户本批明确要求创建本地提交，不推送、不部署、不连接或迁移目标库。

## 范围与结论

**IMG-18 云端对接包交付完成：PASS_LOCAL_HANDOFF。** 本批核对既有 IMG-09～13 会话、登记、关联及实际 S3 签名器，完善第三方可使用的说明和机器样例。App 实现、持久队列、相机调试及真机验收归第三方，不作为本批前置或 BLOCKED。

本批没有新增业务接口、改变 wire schema、配额、签名器、登记事务或关联实现；未修改前端、数据库、IaC 或启用目标设备。设备端仍只有原 `POST /api/v1/device/media/upload-sessions`，上传和确认均复用此接口；没有虚构 GET 登记状态、receipt 查询或每消息业务确认 Topic。

## 交付与修订

| 文件 | 内容 |
|---|---|
| [第三方留档说明](../api/device-archive-vendor-guide.md) | 原 Event/ACTIVE Alarm → triggerRef 申报 → S3 PUT → MQTT media → 重复 POST 确认的顺序；不可变申报、会话重用/到期新办、签名头、错误及登记/关联边界 |
| `docs/api/fixtures/device-archive/openapi.json` | 原上传会话的独立 OpenAPI 3.1，内置 schemas/responses/DeviceMtls，保留旧 IMAGE/VIDEO 和 triggerRef 条件 |
| `event-upload-request.json`、`alarm-upload-request.json`、`legacy-upload-request.json` | 两类触发及旧请求的完整申报，共用真实 811 字节 JPEG/Hash |
| `event-mqtt.json`、`alarm-mqtt.json` | 原触发、media、过期新会话后的新 media；Alarm 包含独立 CLEARED 消息，仍引用原 ACTIVE |
| `mqtt-schemas.json` | common/event/alarm/media 冻结 Schema 原文，无外部文件依赖 |
| `responses.json` | 15 份 HTTP 响应，201 初次、200 有效重用、201 过期新办、409 已登记、申报/配额冲突及普通错误 |
| `s3-put-examples.json` | 精确长度、原 JPEG 字节、SHA-256 Base64、query/Header 两种 checksum 结构；明确不可用签名与示例域名 |
| `capture.jpg`、`manifest.json` | 原 JPEG、长度/KB/hex/Base64 摘要、源契约/策略/签名器摘要、全部导出文件 Hash；归档包共 11 个文件 |
| `scripts/generate-device-archive-handoff.mjs` | 离线可重复导出与 --check，不调用 AWS 或读取凭据 |
| `scripts/cloud-handoff-openapi.mjs` | 两包共用引用收集，支持 response 别名及语义保持，缺失/未支持/重名引用拒绝 |
| `scripts/generate-device-preview-handoff.mjs` | 复用引用收集，IMG-17 五个导出文件字节不变，原新鲜度和测试均通过 |
| `scripts/device-archive-handoff.test.mjs` | 新增 7 项：REST/负例、15 响应、重用/过期/旧请求、MQTT 引用/清除/替换、S3 摘要/头、Hash/cwd、引用错误负例 |
| [原设备包](../api/device-image-device-package.md)、[计划](../api/device-image-development-plan.md)、本文 | 索引、现有业务校验描述、阶段进展与检查边界 |

除首行说明之外，表中 JSON/JPEG 相对路径均位于 `docs/api/fixtures/device-archive/`。样例静态时间与不可用 URL 均有标注，不是运行收据、可执行签名或真实凭据。

## 已落实的对接边界

- triggerRef 精确引用原 meta.id，绑定当前 Customer/device/kind/messageId。ALARM 引用 ACTIVE，不使用 CLEARED 的新 ID，也不按 code/时间猜图。
- 有效重用为 200，保留原会话/Key/createdAt/绝对截止；重签 URL 可变化。过期未登记才新办 201、新路径、新额度，申报/JPEG 保持原值。
- 登记确认是 409 MEDIA_ALREADY_REGISTERED + details.mediaId。PUBACK/S3 2xx/会话 200 都不能代替该业务确认；原消息或 Evidence 是否已关联是另一个状态。
- MEDIA_TRIGGER_CONFLICT 不能当成完成；每日额度为原 409 CONFLICT，不误套预览 429。新签发每设备 UTC 日 100 次，重用和已登记不计新额度，不因过期/失败或换客户清零。
- S3 原二进制上传，精确 Content-Length、原始 SHA-256 的 Base64；SignedHeaders 以实际 URL 为准，checksum query 不删改、被签 checksum Header 必须发送。当前签名器不绑定 ContentType，不将两种结构硬编码为固定 SDK 签名输出。
- MQTT media 不增加 triggerRef/sessionId/Hash/Base64。匹配会话路径逐字符回传，重传保持同条消息所有内容；到期新办使用新 media 消息和序号。原消息时间窗不能通过改 ts/复用 seq 绕过。
- MEDIA_ALREADY_REGISTERED 确认图片登记，不承诺原触发处理或 LINKED；PENDING 后台重试、24 小时 UNMATCHED、清除后关联与 DELETED 保留元数据均沿用原实现。
- 预览两接口与 S3 留档互相独立，预览不消耗归档会话配额。归档不要求 live stream，也不套用预览的 128KiB/10 秒边界。

## 本地检查

本机 Node 24.22.1、pnpm 10.20.0，使用 `/opt/homebrew/bin/pnpm`。日志 `/tmp/img18-*.log` 为本地临时记录。

| 检查 | 结果 |
|---|---|
| `node --import tsx --test scripts/device-archive-handoff.test.mjs scripts/device-preview-handoff.test.mjs` | PASS，12 项（新增归档 7 + 原预览 5） |
| 两个 generator 的 `--check` | PASS，归档 11 文件与源一致；预览 5 文件字节不变 |
| `pnpm exec vitest run apps/cloud-api/test/media apps/cloud-api/test/evidence-image-query apps/ingestion-worker/test/media-evidence apps/ingestion-worker/test/ingest-receipt packages/aws-clients/test/s3-media --maxWorkers=4` | PASS，10 文件、168 项，含会话/旧数据、登记/receipt/解析、读取权限、S3 SDK 签名及对象适配 |
| `pnpm test:contracts` | PASS，319 项 |
| `pnpm openapi:check` | PASS，主 bundle 新鲜度与 Redocly |
| Redocly 独立校验 device-archive/openapi.json 和 device-preview/openapi.json | PASS |
| `node --import tsx scripts/check-delivered-runtime.mjs` | PASS，134 operations |
| boundaries / sensitive-sinks / secrets | PASS |
| 本批四个 MJS 的 ESLint、Prettier、文档本地链接、`git diff --check` | PASS |

机器样例校验验证字段与来源，不能证明对象已经上传或 MQTT 已登记。168 项是云端本地 fixture/数据库模拟/SDK 离线测试，不是第三方 App 执行结果。S3 签名器回归使用本地静态测试凭据进行实际 SDK SigV4 计算，没有向真实 S3 发送请求；归档包中的两份签名仅为不可执行的结构示意。

### FAIL / 修复记录

- 初轮对接包回归为 11 PASS / 1 FAIL：校验脚本未先展开 `components/responses` 别名就读取 content，导致 400 等响应路径异常。修正为先解引用响应再校验其 Schema；保留源路由语义相等断言，没有改 wire 或放宽校验。最终 12 项通过。
- 编辑辅助命令首次使用了非 JavaScript 方法 `String.index`，未完成预览生成器重构；改为 indexOf 后成功。共享引用收集提取后，通过原五项和字节新鲜度证明预览导出不变。

最终未解决 FAIL=0、BLOCKED=0。历史失败保留。

### NOT_RUN

- 真实云端 HTTP/mTLS、S3 PUT/签名头接受结果、实际设备 MQTT/PUBACK 和业务登记公开链路。本批没有执行这些请求，也没有将示例当作运行收据。
- 云部署、目标库连接/迁移、设备/白名单启用及 Git 推送。
- 全仓 pnpm verify、全量 Vitest、前端 Playwright、CDK synth、目标并发/性能门禁；本批未更改业务后端、前端或 IaC，只执行上表适用检查。

App 实现、持久队列、拍照业务白名单选择、相机调试与真机验收为 OUT_OF_SCOPE，不作为本批待补齐或 BLOCKED。G3 仍为 PARTIAL，云端组合集成和完整门禁按 IMG-19/20 收口，不因缺少 App 仓库阻塞本包交付。

下一可执行任务：将指南与 11 个归档文件交第三方使用；本仓库研发可继续 IMG-19 云端组合集成。未代发消息或上传第三方系统。
