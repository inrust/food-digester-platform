# IMG-17 云端接口对接包交付记录

日期 2026-11-07，参考提交 `aac4ebc85d01a4b74224dc529e4be664263ce3d3`。初始 main 工作区干净，已有 13 个未推送提交。按用户要求仅创建本地提交，不推送、不部署、不迁移目标库、不启用目标设备。

## 本批范围与结论

用户先提供了 App 路径占位符，随后明确“APP 由第三方软件公司开发，只需要提供接口”“我们只负责云端对接包交付，不用管 App 实现、真机验收”。本批以最终职责澄清为准：**IMG-17 云端对接包交付完成，PASS_LOCAL_HANDOFF**。

不要求 App 路径、分支、技术栈或源码，不将这些事项列为本批 BLOCKED，也不把第三方 App 实现、相机调试和真机验收列为本仓库待办。原计划任务的职责说明已同步；云端本地功能、公开部署与第三方软件交付仍是不同状态。

检查了云平台分支、工作区、唯一 AGENTS.md、冻结 OpenAPI/策略、IMG-08 白名单准入与 IMG-05～08 设备接口实现。当前已存在且本地实现的两个接口是：

- GET `/api/v1/device/live-image/state`：设备 mTLS，IDLE / ACTIVE、streamId、activeUntil、5 秒查询参数。
- POST `/api/v1/device/live-image/frames`：设备 mTLS，JPEG/Base64、200 接收/重放、大小/格式/会话/授权/限频错误。

本批没有重新编写业务后端，没有新增云端路由、权限、依赖、数据库迁移或启用操作。App 路径搜索在职责澄清后停止，没有访问或修改第三方代码。

## 交付文件

| 文件 | 内容 |
|---|---|
| [第三方接口说明](../api/device-live-image-vendor-guide.md) | 两接口认证、逐字段请求响应、5 秒查询/2 秒采样、单帧在途、期限、流变化、断网/超时/429/重启/权限拒绝的调用要求；与 S3 留档分离 |
| `docs/api/fixtures/device-preview/openapi.json` | 独立 OpenAPI 3.1，仅两个设备接口，内置全部引用；来自冻结契约，不另立协议 |
| `docs/api/fixtures/device-preview/frame-request.json`、`capture.jpg` | 完整 Base64 请求和同字节 JPEG，固定样例时间，不冒充当前可用帧 |
| `docs/api/fixtures/device-preview/responses.json` | 21 份状态、接收、重放和错误响应，匹配实际 HTTP Schema |
| `docs/api/fixtures/device-preview/manifest.json` | 输出文件长度/SHA-256、源契约/策略/样例摘要，校验来源及新鲜度 |
| `scripts/generate-device-preview-handoff.mjs` | 离线可重复导出与 `--check`，无网络/凭据/云端调用 |
| `scripts/device-preview-handoff.test.mjs` | 子集语义与鉴权一致、引用自足、响应码和 Schema、完整图像字节、请求负例、Hash、新鲜度和跨 cwd 执行 |
| [原设备对接包](../api/device-image-device-package.md)、[开发计划](../api/device-image-development-plan.md) | 明确第三方职责及本批完成条件；按实际代码修正白名单来源 |
| 本文 | 检查结果、历史失败、未执行范围和提交边界 |

当前实际白名单为 `DeviceLiveImagePolicy.enabled`，缺行/false 即关闭；原对接包“云端部署配置白名单”描述已同步为数据库准入。App 不能通过请求开启白名单，不能把设备暂停/退役或 403 当成 IDLE。本批未写入任何准入记录。

导出地址为不可用示例 `https://device-api.example.invalid`，实际设计域名/环境确认方式在指南中说明。模板 curl 未执行，没有提供或生成设备凭据。生成子集保留两路由全部冻结约束和错误定义；不修改主 OpenAPI、SDK 类型或契约基线。

## 本地检查结果

使用 Node 24.22.1、pnpm 10.20.0；命令在云平台仓库根执行。日志 `/tmp/img17-*.log` 为临时本地证据。

| 命令 / 检查 | 结果 |
|---|---|
| `node scripts/generate-device-preview-handoff.mjs --check` | PASS，五个导出文件与当前来源逐字节一致 |
| `node --import tsx --test scripts/device-preview-handoff.test.mjs` | PASS，5 项；21 份响应及完整 JPEG/Base64，负例/来源 Hash/跨 cwd 校验 |
| `pnpm exec vitest run apps/cloud-api/test/live-image packages/aws-clients/test/live-image --maxWorkers=4` | PASS，实际匹配 6 个 cloud-api 文件、171 项；包路径本次未增加命中，不能声称额外运行了适配器套件 |
| `pnpm test:contracts` | PASS，319 项，含旧上传与 MQTT/REST 兼容性契约 |
| `pnpm openapi:check` | PASS，主 bundle 新鲜度与 Redocly |
| `pnpm exec redocly lint docs/api/fixtures/device-preview/openapi.json --extends spec` | PASS，独立包无外部引用依赖，可单独解析 |
| `node --import tsx scripts/check-delivered-runtime.mjs` | PASS，134 operations，生产路由与契约一致 |
| `node scripts/check-boundaries.mjs` | PASS |
| `node scripts/check-sensitive-sinks.mjs` | PASS |
| `node scripts/check-secrets.mjs` | PASS |
| 两个脚本 ESLint、Prettier、文档本地链接和 `git diff --check` | PASS |

171 项是本地云端租约、帧、读取、鉴权和运行入口已有测试的回归，覆盖暂停/退役/归属和流失效、限频、并发等云端处理，不是第三方 App 的执行结果。新增 5 项只证明对接包与冻结契约一致，不模拟 App 实现，也不伪造设备验收。

### FAIL / 修复保留

- 导出器首轮 FAIL：DeviceMtls 在 live OpenAPI 中是指向 base 的同名 `$ref` 别名，首次收集误判为名称冲突。修正为先解析别名再登记来源，保持真实名称冲突拒绝；独立 Redocly 及两个路由展开后语义相等的断言均通过。
- 文档编辑辅助命令曾因 stdin 非 UTF-8 编码失败，没有完成该批编辑；改用补丁/UTF-8 文件读写后成功，文档链接及差异已复核。不涉及运行接口错误。

最终未解决 FAIL=0、BLOCKED=0。没有以 App 源码缺失作为阻塞，没有因本批通过而宣称公开环境已上线。

### NOT_RUN（本批有意不执行）

- 云资源部署、目标库连接/迁移、服务端白名单写入、目标设备启用、任何真实设备证书请求或实际公网接口调用。
- 完整 `pnpm verify`、全量 Vitest、前端 Playwright、CDK synth 和目标环境性能测试。本批只调整对接材料、导出与校验脚本，没有修改业务后端、前端或 IaC，执行上表相关本地检查。
- 实际网络条件下的 mTLS/网关与 S3 行为；对接包只报告静态契约与本地云端测试结果。
- Git 推送。

App 实现、相机调试、真机验收属于 **OUT_OF_SCOPE**，不作为本批 NOT_RUN 缺项、补齐条件或下一任务。G0 保持原 PASS；G1/G2 的目标证据边界不变，G3 仍因云端组合集成/完整门禁未完成保持 PARTIAL，而不是因没有第三方 App 仓库而阻塞。

下一可执行任务：向第三方提供指南及 `device-preview` 五个文件即可开始接口对接；如继续本仓库研发，则按 IMG-19/20 收口云端组合集成与质量门禁。本文没有代发消息或上传材料到第三方系统。
