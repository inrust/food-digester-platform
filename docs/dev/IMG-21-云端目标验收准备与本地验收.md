# IMG-21 云端目标验收准备与本地验收

2026-11-08，基于本地 `6dec17205fc87490e579b084dbcf2d29d5a7bdf5`。进入 main 工作区干净，领先 origin/main 17 个本地提交；已核对根 AGENTS.md。按本次用户明确要求只创建本地提交、不推送，不调用真实云端接口、不部署、不连接或迁移目标库、不启用目标设备。此前“六项要求”原文未出现在可见记录，已向用户确认按下述六项继续。

## 结论与范围

**IMG-21 准备阶段为 PASS_OFFLINE_PACKAGE；目标执行未开始，G4 保持 NOT_RUN。** 交付12文件的目标执行包和44个目标用例、35项有提供方的输入模板、输入/证据/源摘要校验器及58项新测试。G3沿用并重新校验候选6dec1720内的已封存本地证据，不冒充本批重新执行完整 pnpm verify。

目标准入为 **BLOCKED：35项目标输入未提供，另有1项源码确认的目标可达性限制**。这些不是本次准备材料的失败，也不证明目标资源缺失或未部署。App实现、相机/队列和真机验收由第三方负责，不是本仓库本次前置或BLOCKED。

[执行指南](../api/device-image-target-acceptance-guide.md) · [生成包](../api/fixtures/device-image-target) · [本地机器记录](../audit/evidence/2026-11-08-device-image-IMG21-preparation/result.json)

## 六项落实

| 要求 | 本批交付与判定 |
|---|---|
| 1 候选与G3证据绑定 | 固定6dec1720完整SHA；从Git对象核对1693份源摘要、34份证据摘要及G3的22阶段/七专项通过记录，再检查工作区原有G3输入不变；新工具/用例/SQL另以protocolDigest绑定，无历史receipt改写 |
| 2 环境/身份/权限输入 | 35项value=null模板，每项有提供方/类型；部署版本、迁移、IAM/表/入口、两设备两租户、身份逻辑ref、独立恢复身份、原生作业/故障/24h窗口、序号及清理/SLA；proof不仅检查Hash，还检查与环境/候选及详细预算一致。初始缺项全部保留 |
| 3 五个预览接口 | PV01～14覆盖缺省关闭、租约申请/续租/释放/状态/最新帧，READY/UNCHANGED/WAITING、边界、限频、CORS/no-store、双viewer、跨租户/当前授权及跨实例共享；请求体/参数/错误来自冻结OpenAPI |
| 4 S3与event/alarm | AR01～14覆盖两触发×两先后顺序、triggerRef精确关联、不可变申报/重用/到期新办/已登记、S3实际SignedHeaders、登记事务/Outbox、重复和清除后关联、读取/删除、旧数据和配额独立；配额耗尽排在NC之后，避免阻断新签发 |
| 5 原生并发/撤权/恢复 | NC01～12明确真实DDB事务/CAS/逻辑截止、原生PG多进程/多连接屏障、八种权威变化、回滚/提交后恢复失败/未知提交/迟到I/O/Outbox竞争；只读业务SQL经本地迁移库验证，原生PID锁诊断仍NOT_RUN。退役只用批准的一次性设备，保留终态 |
| 6 顺序/清理/G4判定 | 有依赖图、独占runId和资源台账、窗口/停止条件、仅本轮资源清理、CONTROL epoch/历史关联保留、实际24h要求、证据路径/Hash/环境/时间/变体/清理严格校验。工具不提供execute/deploy/migrate开关，不自动给G4 PASS |

## 修改文件

- `scripts/device-image-target-package.mjs`：离线组包、G3对象校验、输入准入、脱敏/路径/证据/清理结构校验；只有本地文件与git子进程，无HTTP/AWS/数据库客户端或凭据读取。
- `scripts/device-image-target-cases.json`：44项用例、最小依赖、逐断言及特殊变体要求。AR14在NC12之后，配额耗尽不阻断前序业务。
- `scripts/device-image-target-read-only.sql`：只读且按租户/设备/原消息/seq限定的业务核对；原生锁PID诊断单独标注。
- `scripts/device-image-target-package.test.mjs`：58项测试，含当前源/历史证据校验、生成新鲜度/cwd、负向准入/证据篡改/路径越界、原生替身拒绝、窗口/清理和本地PGlite执行只读SQL。
- `docs/api/device-image-target-acceptance-guide.md` 与 `docs/api/fixtures/device-image-target/`12文件：六项操作指南、候选/输入/用例/证据/资源/可达性模板、独立OpenAPI/请求清单、完整JPEG/Base64、只读SQL及manifest。
- `docs/api/device-image-development-plan.md`、本文与本批evidence目录：准备状态、完整检查/失败/缺项与源摘要；`.gitattributes`仅对本批原始日志沿用空白保留规则。

未修改业务后端、平台页面、数据库Schema/迁移、权限矩阵、IaC、设备或白名单配置。没有部署或启动目标执行器；native屏障/故障过程是后续已授权隔离执行器应落实的步骤，不是已执行结果。

## 本地检查

本机Node24.22.1、pnpm10.20.0，使用 `/opt/homebrew/bin/pnpm`。

| 检查 | 结果 |
|---|---|
| 新工具定向 node:test | PASS，58项；含纯结构夹具，不能当目标运行证据 |
| 全仓 `pnpm test:scripts` | PASS，1580项；既有本地TLS broker/HTTP测试需回环端口，未连接真实云 |
| `pnpm test:contracts` | PASS，319项；冻结契约、原MQTT与旧请求回归 |
| 全仓 lint / format:check | PASS |
| `pnpm openapi:check` | PASS，原契约bundle新鲜度与Redocly |
| 执行包独立OpenAPI Redocly | PASS，无外部引用；parameter别名在本包内联，原共享生成器未改 |
| `--generate` / `--check` | PASS，12文件逐字节与集合校验，44用例，所有目标行NOT_RUN |
| `--admission` 初始模板 | 退出2、BLOCKED，35缺项+1可达性限制；本地校验按预期通过，不改成0掩盖未就绪 |
| `--receipt` 初始模板 | 退出2、NOT_RUN，44项未执行，G4 NOT_RUN；不是测试FAIL |
| boundaries / runtime / migrations / evidence / sensitive-sinks / secrets | PASS，134路由、本地实际迁移漂移、边界与静态脱敏检查 |
| 两个既有对接包generator `--check` | PASS，预览5文件/归档11文件不变 |
| 源/包/证据摘要、文档链接、git diff --check | PASS；源清单绑定本批材料，历史G3内容按Git候选对象复验 |

完整pnpm verify、全量Vitest、前端Playwright、全量构建/tsc、CDK synth本批NOT_RUN。没有业务TS/前端/IaC改动，执行上述本批适用检查；6dec1720的完整verify只作不可变候选背景，不声称覆盖本批新增工具。

## FAIL 历史与修复

1. 初轮组包脚本少一个括号，解析失败；修正后才生成文件，无部分目标执行。
2. 复用的冻结共享OpenAPI导出器不支持parameters别名，遇到Cursor拒绝；仅在新执行包先内联已bundle的parameter引用，不改旧共享生成器或契约语义，Redocly通过。
3. BLOCKED行曾被顶层归为NOT_RUN，新负例失败；保持G4 NOT_RUN的同时顶层保留BLOCKED，后续58项通过。
4. ESLint检出未使用relative导入、正则连续空格，修正为移除导入与显式空格量词；全仓lint/format通过。
5. 全脚本首轮3 FAIL：沙箱拒绝监听127.0.0.1/::1，分别为本地TLS broker、延迟body、总deadline测试。放开本地回环端口后原测试不改断言重跑，全仓1580项通过；没有增加重试或访问目标环境。
6. 两次辅助文本编辑因输入编码错误未落盘，改用ASCII编辑/UTF-8补丁后完成；未改变候选源或云资源。

最终未解决的**本地FAIL=0**。上述首次失败日志保留，正常的负向拒绝与模板退出2单独记录，不混成目标通过。

## BLOCKED与NOT_RUN

### 目标准入 BLOCKED

35个环境、身份、窗口和预算输入全部未提供，机器明细见同批`admission.json`，提供方见指南。除此之外，候选V1五种固定角色都含media:read，DEC-012不支持矩阵编辑；AR12“告警读取成功但仅省略图片字段”的目标变体不能靠换正常角色实现。保留 `mediaPermissionDenyPath`，由云端验收/权限策略负责人明确可达性和验收口径。

零角色/禁用账户导致整个请求拒绝，不能替代该字段省略分支；G3权限拒绝注入不能补作G4真实证据。本包不改权限矩阵、不造角色、不删用例或设置waiver；填齐全部其余输入后，该项仍使整体准入BLOCKED。材料准备仍可完成。

### NOT_RUN

- 全部44项目标用例；所有真实公开HTTP/Cognito/mTLS/S3/IoT/SQS/DDB/PG/Outbox观测、实际IAM/CORS/网关大小限制与日志结果。
- 原生DDB事务/TTL、多进程PG锁、跨库撤权与未知提交/迟到响应；本地SQL/PGlite与合成元数据的结构检查不替代。
- 真实15分钟会话到期、24小时终态、设备规模/首帧/吞吐/成本验收。
- 真实云调用、目标执行器启动、部署、目标库连接/迁移、目标设备/白名单启用、Git push；按用户明确边界未执行。
- 本批完整verify/构建/TS/全Vitest/Playwright/CDK，原因见适用检查表。

App/真机为OUT_OF_SCOPE，不计这36条云端准入阻塞，不要求提供App源码。G3候选的PASS_LOCAL不变；IMG-21完整目标执行未完成，G4/G5不升级。

## 证据与复验

机器记录绑定完整候选SHA、本批protocolDigest、生成manifest摘要、全部修改源/文档摘要、命令退出码、首次FAIL、36条目标准入阻塞和44项NOT_RUN。历史G3/QA09证据不改写；本批原始日志按字节归档。source/artifact两份清单不自哈希，最终含证据的提交号以Git记录和最终回复为准。

```bash
node scripts/device-image-target-package.mjs --check
node --import tsx --test scripts/device-image-target-package.test.mjs
shasum -a 256 -c docs/audit/evidence/2026-11-08-device-image-IMG21-preparation/sources.sha256
shasum -a 256 -c docs/audit/evidence/2026-11-08-device-image-IMG21-preparation/artifacts.sha256
```

下一可执行任务：先由云端验收/权限策略负责人收口AR12目标可达性口径，再按提供方补齐目标输入及独立执行窗口。后续目标动作仍需明确授权；本包不自动进入部署、迁移或设备启用。交付第三方的既有两条云端接口包可独立使用。
