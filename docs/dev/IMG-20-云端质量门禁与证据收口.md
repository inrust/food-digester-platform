# IMG-20 云端质量门禁、源摘要与验证证据

2026-11-08，基于 `e20f3ce4446156b9dcca89bbc1b4cde91b3e7148`。开始时 main 工作区干净，领先 origin/main 16 个本地提交。已检查根 AGENTS.md；按用户本次明确要求只创建本地提交、不推送，优先于仓库默认推送规则。

## 结论

**IMG-20 已完成；G3 达到 PASS_LOCAL（云端本地集成）。** 完整 `pnpm verify` 的 22 个顺序阶段通过，退出码 0，七份本地专项 receipt 均为 PASS。执行时间为北京时间 08:06:40～08:17:33，耗时约 10 分 53 秒。G4/G5 及 QA09 真实业务验收不随本地门禁升级。

[机器记录](../audit/evidence/2026-11-08-device-image-IMG20/result.json)列出完整命令、执行时间、退出码、源摘要、历史 FAIL、BLOCKED 和 NOT_RUN；[原始完整日志](../audit/evidence/2026-11-08-device-image-IMG20/verify.log)及七份本地专项 receipt 同批归档。IMG-19 的原记录保留为历史证据，没有覆盖为本轮结果。

本批为云端本地交付。App 实现、相机/持久队列、真机验收属于第三方 OUT_OF_SCOPE，不作为 BLOCKED 或 G3 本地完成条件。没有部署、连接或迁移目标库、启用目标设备或推送。CDK 只做离线 synth，PGlite 只回放本地临时迁移。

## 修复与修改文件

| 文件 | 改动及原因 |
|---|---|
| `contracts/testing/baselines/0.16.0.json` | 仅 Prettier 排版；与父提交解析后的 JSON 深相等，线协议、版本和兼容审批摘要不变 |
| `contracts/testing/device-contract.ts`、`scripts/contract-suite.test.mjs` | 响应头按 HTTP wire 序列化校验，支持数字型 Retry-After 的字符串；新增缺头、非法秒数/非整数及 JSON body 错误类型负例，body 严格类型保持 |
| `apps/cloud-api/test/device-image-contract-gate.test.ts` | 真实设备状态/帧 Handler 的成功、非法输入、未认证和已声明错误映射；授权端口故障注入不冒充原生适配器故障实测 |
| `apps/cloud-api/test/media-trigger-sessions.test.ts`、`scripts/run-contract-suite.mjs` | 触发会话真实 Handler 纳入设备专项，覆盖重用 200；两个设备预览接口纳入原专项，全量声明响应状态继续严格要求 100% |
| `scripts/run-admin-e2e.mjs`、`scripts/admin-e2e.test.mjs` | 登记实际发现的 48 个独立用例（新增图片十项），校验结构化行为证据，增加缺失字段负例；维持未知/遗漏/重复用例拒绝和零重试 |
| `scripts/qa08-bindings.mjs`、`scripts/run-prototype-regression.mjs`、`scripts/prototype-regression.test.mjs` | DEC-009 已确认的四个 camPlay/camStop 移入正向图片行为组，121 正向 + 7 缺席仍覆盖全部 128 个原型决策；开始/停止适配为同一切换按钮，补充 liveImage 行为 guard |
| `apps/admin-web/e2e/qa08-fixture.ts`、`qa08-prototype.spec.ts` | 使用冻结类型的本地 JPEG/租约响应，实际断言打开、显示 JPEG、关闭清图及释放租约，375/1440 两种宽度均执行 |
| `apps/admin-web/e2e/qa08-snapshots/device-{view,operate}-{375,1440}.json`（四份） | 经审查仅增加“实时图片预览”标题和入口；基线更新模式的 4 PASS 不计作验收，随后普通模式复验全部 24 项 |
| `scripts/database-migration-runner.test.mjs`、`qa09-db-readonly-probe.test.mjs`、`qa09-legal-write-inventory.test.mjs` | 与当前图片实现同步：61 张表、44 项迁移、65 个管理写操作；三张新增表名另有明确断言 |
| `scripts/qa09-nonactive-browser.mjs`、`qa09-nonactive-browser.test.mjs` | 目标工具清单同步 121 项；新增预览组明确 NOT_RUN，要求独立 opt-in 与设备帧，不因新增分支默认为 PASS |
| `scripts/qa09-acceptance-entry.test.mjs` | 当前执行器正例使用临时生成的当前 scope，保留历史 117 项台账及原有正式通过数为零/业务 PARTIAL 断言；新增旧冻结范围必须拒绝当前源码的负例，未改历史 receipt 或放宽校验器 |
| `.gitattributes` | 沿用仓库既有原始日志规则，仅本批日志目录豁免空白检查，保留命令输出原始字节；源码仍执行正常空白检查 |
| `docs/api/device-image-development-plan.md`、本文及本批 evidence 目录 | 阶段结果、源摘要、日志/receipt、失败和未执行边界 |

没有修改业务后端、页面、数据库迁移、权限、IaC 或设备启用逻辑。对接包源和导出文件保持一致；没有把旧请求或 MQTT 协议升级为新格式。

## 本地检查

Node 24.22.1、pnpm 10.20.0，调用 `/opt/homebrew/bin/pnpm`。完整命令保持 package.json 原顺序和失败即退出语义，未删减阶段、跳过用例、提高重试或降低通过阈值。

| 检查 | 结果 |
|---|---|
| 完整 `pnpm verify` | PASS，22 阶段，退出 0；不是仅定向检查的替代结果 |
| lint / format:check / typecheck / openapi:check / build | PASS，全仓类型与 E2E 类型、主 OpenAPI 新鲜度及 Redocly、各包构建 |
| `pnpm test` | PASS：Vitest 221 文件/2176 项，contracts 319 项，scripts 1522 项 |
| boundaries / schemas / migrations / evidence / secrets / sensitive-sinks | PASS；本地实际迁移漂移、证据文档及生产日志/Trace sink 静态脱敏检查 |
| admin-web-delivery / admin-web-e2e | PASS；默认 Chromium 48 项 |
| cmd-ota-delivery（runtime + cdk） | PASS，134 operations；离线 synth 无 CDK warning，合成账户 000000000000，禁用 metadata 和凭据文件 |
| device-contracts | PASS，11 MQTT Schema、10/10 设备接口、297 次真实 Handler 响应、全部声明状态覆盖 |
| iot-integration | PASS，本地正常入口八类上行、故障、回滚与清理 |
| core-api-integration | PASS，140 项，本地迁移 PGlite/身份及外部端口替身 |
| admin-e2e-suite | PASS，48 串行 + 96 双 worker 重复执行，共 144 次；零重试、独立 prefix、结构化行为证据 |
| security-suite | PASS，217 项，本地鉴权/隔离/输入/脱敏及独立泄漏扫描 |
| reliability-suite | PASS，默认 quick，本地 2 项；不是目标性能验收 |
| prototype-regression | PASS，24 项，128 个决策、375/1440、24 份语义快照；非更新模式 |
| 两个 handoff generator `--check` | PASS，预览 5 文件、留档 11 文件与冻结源一致 |
| 冻结基线 JSON 语义相等、源清单、文档链接、git diff --check | PASS；最终文档与证据另行复验 |

设备专项同时覆盖 11 类原 MQTT Schema/正负例/Hash 和类型变异，IoT 专项继续走本地正常分发入口的八类上行消息。预览和留档 generator 的 `--check` 分别确认 5/11 个文件新鲜度；S3 签名头/JPEG/Base64/triggerRef/会话重用/登记确认样例的原测试纳入 1522 项脚本回归。没有将离线签名计算或样例静态验证当成真实 S3 接受结果。

## FAIL、BLOCKED 与警告

历史失败日志位于 evidence 的 `failures/`，不以最后一次成功删除历史记录：

1. 首次完整门禁在 format:check 失败：0.16.0 基线排版；语义相等后仅修排版。
2. 独立浏览器专项失败 `BROWSER_DISCOVERY_MANIFEST_MISMATCH`：新图片用例未登记；补清单和结构化证据，保留严格发现校验。
3. 独立设备专项失败 `INCOMPLETE_OPERATION_COVERAGE createMediaUploadSession: 200`：补真实触发会话及预览 Handler 后，继续暴露测试器错误地按 JSON 整数检查 HTTP Retry-After 字符串；修正 wire 校验，并增加负例。
4. 新增云端测试 typecheck 失败：exactOptionalPropertyTypes 下未认证请求需要省略 identity；新增 E2E 夹具 typecheck 失败：READY 不能多报 receivedAt。均修正测试输入，保持生产严格类型。
5. 脚本初轮 1521 项中 12 FAIL：表/迁移/写操作旧计数、四个摄像头控件的原型正负绑定、历史 scope 被当作当前执行器正例。同步当前绑定/夹具，保留旧 receipt 与拒绝漂移逻辑。
6. 定向回归检出原型“缺少缺席断言”负例在已无缺席项的页面空数组上 pop 无效果，以及目标语义工具仍有 117 项断言。改为选择实际有缺席项的页面，目标清单与当前 121 项同步，新预览组仍 NOT_RUN。

7. 暂存后首次 git diff --cached --check 检出原始日志的行尾空格；按仓库既有 .gitattributes 做本批日志目录的定向属性，不修剪或重写日志，原始字节 Hash 保留。

最终未解决 FAIL=0、BLOCKED=0。预期拒绝旧冻结范围的负向测试为 PASS，不是被忽略的目标验收失败。

保留 Vite 大于 500kB 分块提示、浏览器 NO_COLOR/FORCE_COLOR 提示，不调阈值或屏蔽；本地构建通过不形成目标性能结论。一次辅助报告编辑命令因编码错误未落盘，后续按 UTF-8 文本完成，不影响冻结源码或门禁结果。

## NOT_RUN 与范围

- 原生 DynamoDB 事务、跨进程竞争及 TTL 清扫；原生 PostgreSQL 多连接行锁和跨库授权失效窗口。本机 PATH 未找到 docker/postgres/initdb，也没有安装或启动相应服务。本地 CAS/SDK 命令/PGlite 不能替代。
- 公开 Gateway、真实 Cognito/mTLS、实际 S3 PUT/签名头接受、真实 IoT/SQS/Outbox 跨服务链路，以及网络缓存和撤权传播。
- 目标规模负载、首帧/刷新/帧龄/成本 SLA；可靠性专项仅默认 quick 本地 profile，full profile 未执行。其他浏览器的兼容性矩阵未执行，仓库默认 Chromium 已执行。
- 云部署、目标库连接/迁移、目标设备/白名单启用、Git push：按本次用户边界未执行。
- App 实现、相机/队列和真机验收记 OUT_OF_SCOPE；不从本地接口包或浏览器通过推断第三方实现已通过。

G4 真实云端和 G5 真机验收没有升级。G1/G2 文档中真实适配器和目标环境缺项保留；本轮执行器单测通过也没有将 QA09 历史真实业务 Gate 从 PARTIAL 升级。

## 源摘要和复验

完整核验前后检查的 1695 份输入文件没有漂移。交付的 `sources.sha256` 排除核验后更新的开发进度文档与原始日志 Git 属性，包含 1693 份 apps/packages/contracts/infra/scripts、根配置及设备接口包文件；自身 SHA-256 为 `3bc73457eff8cc8cbc1d081869334925c90913922965dcad62533fe64c691f2f`。

父提交 + 源清单定义本次运行候选；七份原生本地 receipt 的 baselineCommit 是父提交，不能单凭它声称本批修复已在父提交内。每份 receipt 的产生时间均位于本次完整 verify 时间窗内；新增的未跟踪测试也被源清单覆盖。包含本批源与证据的最终本地提交由 `git log -- docs/dev/IMG-20-云端质量门禁与证据收口.md` 定位，最终回复同时给出提交号。

`artifacts.sha256` 覆盖日志、七份专项 receipt、result、源清单和核验后更新的本文/计划/Git 日志属性，排除自身以避免循环摘要；源码构建产物、历史 evidence 不纳入源清单。历史 IMG-19 及 QA09 文件没有改写。本轮资料是本地 G3 证据，不是托管 CI、真实云端或发布凭据。

在仓库根目录复验：

```bash
shasum -a 256 -c docs/audit/evidence/2026-11-08-device-image-IMG20/sources.sha256
shasum -a 256 -c docs/audit/evidence/2026-11-08-device-image-IMG20/artifacts.sha256
pnpm verify
node scripts/generate-device-preview-handoff.mjs --check
node scripts/generate-device-archive-handoff.mjs --check
```

摘要校验仅检验归档完整性，不能代替重新执行测试。重新运行需保持本地浏览器端口与离线环境；真实云端结果仍需单独记录。

下一可执行任务：IMG-21 云端目标验收准备，整理隔离环境输入、身份与权限、原生适配器并发断言和执行清单；实际部署、目标库迁移或设备启用须另有授权，不自动执行。第三方 App 和真机工作不作为本仓库继续准备的前置。
