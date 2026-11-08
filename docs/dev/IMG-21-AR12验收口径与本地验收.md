# IMG-21 AR12 验收口径与本地验收

2026-11-08，基于 `ee27ed4525d32920cfd9378085f02d61b0bd1d80`，开始时 main 工作区干净、与本地 origin/main 引用一致；没有 fetch/push。应用候选仍为 `6dec17205fc87490e579b084dbcf2d29d5a7bdf5`。已核对根AGENTS.md，用户明确要求不推送，优先于仓库默认推送规则。

## 结论与 G4

**AR12 口径已收口，适用本地检查通过。** 固定V1的AR12/no-media-permission（源查询200但单独缺media:read，省略evidenceImage）记为 **NOT_APPLICABLE_SOURCE_BOUND**，不是目标PASS。满足固定候选、10份相关源码摘要和当前源版本的本地拒权回归时，该单一变体不再单独阻塞G4；源码/候选/回归依据失效则恢复 `ar12ScopeRevalidationRequired` BLOCKED。

44个目标用例不删减，AR12保留六条变体记录：五条可达变体仍须真实目标验证，一条源码N/A单列。其余FAIL/BLOCKED/NOT_RUN、35项环境/身份输入缺失和真实来源/原生并发/24h/清理证据缺失仍阻止G4。本次44个用例均未执行，G4保持NOT_RUN。App/真机由第三方负责，不构成本批阻塞。

[正式口径](../api/device-image-AR12-acceptance-scope.md) · [更新后的执行指南](../api/device-image-target-acceptance-guide.md) · [本地机器记录](../audit/evidence/2026-11-08-AR12-acceptance/result.json)

## 修改文件与行为

| 文件 | 改动 |
|---|---|
| `docs/api/device-image-AR12-acceptance-scope.md` | 决策AR12-V1-MEDIA-OMISSION-NA-1，明确适用范围、分母、记录字段、失效条件和G4影响 |
| `scripts/device-image-target-ar12-scope.mjs` | 单一源码N/A验证模块：比对候选Git对象和当前10份源码，核对DEC-012冻结状态、本地完整Vitest报告及明确七个关键用例，生成policyDigest；无通用豁免开关 |
| `scripts/device-image-target-package.mjs` | 删除永久的mediaPermissionDenyPath阻塞；增加sourceExclusions精确记录、源码/回归失效恢复BLOCKED、唯一变体N/A识别；整项AR12或其他变体N/A拒绝，目标证据仍严格要求；即便父项NOT_RUN也保留子项FAIL/BLOCKED |
| `scripts/device-image-target-cases.json` | AR12六个ID不删，目标断言与源码排除分开；PV12保留整个请求被拒绝的实测，使用revoked-or-zero-role变体 |
| `scripts/device-image-target-package.test.mjs` | 102项（原58+新增44），覆盖N/A伪造/扩散/删项、实际失败被掩盖、旧协议/角色输入名、源码及本地报告漂移、无目标证据等 |
| `docs/api/fixtures/device-image-target/` | 仍12文件；重生成cases/inputs/receipt/reachability/manifest。receipt含唯一sourceExclusions、AR12对应N/A记录且无目标evidenceRefs；其余44项仍NOT_RUN |
| `docs/api/device-image-target-acceptance-guide.md`、`device-image-development-plan.md` | 移除当前“永久BLOCKED”描述，改为受源码约束的单一N/A；其余目标验收不放宽 |
| 本文、同批evidence目录、`.gitattributes` | 本地回归原始报告/日志、FAIL历史、35个输入缺项与44项NOT_RUN及源摘要；仅本批原始日志保留空白 |

将误导性输入名noMediaRoleRef改为rejectedIdentityRef（数量仍35），用于当前被撤权/零角色等整个请求拒绝的身份。旧输入形状/旧protocolDigest不能继续套用；不要求制造V1不存在的“仅缺图片权限”角色。

**V1权限矩阵、角色、鉴权/业务后端、OpenAPI契约、数据库Schema/迁移、IaC均未修改。** 检查Git差异和候选源码Hash确认。测试的拒权注入只在进程内，不写生产权限文件或目标数据库。此前IMG-21准备报告与ee27ed45的36条阻塞是历史记录，没有覆写为本轮结论。

## 记录与校验规则

- receipt.sourceExclusions恰好一条，绑定caseId=AR12、variantId=no-media-permission、status=NOT_APPLICABLE、decisionId、sourceCommit、policyDigest、reasonCode；targetExecuted=false、evidenceRefs=[]。
- AR12对应变体必须为同一决策/摘要的N/A，不能删除、标为目标PASS或挂目标云证据；即使未被引用的目标artifact声明此分支也拒绝。
- 五个可达变体仍须PASS及实际variantId证据，HTTP/DB/S3和三个目标断言不允许减少。整项AR12、其他变体或其他用例不能N/A。
- local-regression.json明确LOCAL_PERMISSION_DENY_INJECTION_ONLY，绑定原始Vitest报告Hash、候选和10份源码。完整34项均通过，含ALARM/EVENT字段省略两项、五角色矩阵五项，缺失/失败/跳过/篡改均失效；不把这些本地材料作为目标证据。
- protocolDigest涵盖新验证模块、口径文档、回归依据和原执行包代码/用例；旧receipt即使只换protocolDigest，缺少精确sourceExclusions仍拒绝。JSON对象字段顺序变化不导致虚假失败。

## 本地检查

Node24.22.1、pnpm10.20.0，使用 `/opt/homebrew/bin/pnpm`；没有真实云调用。

| 检查 | 结果 |
|---|---|
| Vitest evidence-image-query.test.ts | PASS，34项、无失败/跳过；完整JSON报告与输出日志归档，含七项明确矩阵/拒权分支用例 |
| 目标执行包node:test | PASS，102项 |
| 全仓 `pnpm test:scripts` | PASS，1624项；允许既有测试的本地回环broker/HTTP服务，不访问真实云 |
| `pnpm test:contracts` | PASS，319项，冻结契约与旧请求/MQTT回归 |
| 全仓lint / format:check | PASS |
| `pnpm openapi:check`、独立目标子集Redocly | PASS；没有wire变更 |
| 包生成/新鲜度 `--check` | PASS，12文件/44用例，G3固定候选源摘要仍可验证 |
| `--admission`空模板 | 预期退出2、BLOCKED，剩35项缺失输入；不再永久附加mediaPermissionDenyPath |
| `--receipt`模板 | 预期退出2、NOT_RUN，44项目标未执行；源码N/A记录可核验但不计目标PASS |
| boundaries / evidence / sensitive-sinks / secrets、文档链接/摘要/差异 | PASS，原始日志一并检查；源及提交字节另复验 |

完整pnpm verify、全量Vitest/前端E2E/构建/TS/CDK/目标迁移门禁本批NOT_RUN；没有修改业务TS、前端、迁移或IaC，按上述适用范围验证。不能把6dec1720原有G3完整verify说成本轮新执行。

## FAIL、BLOCKED、NOT_RUN

### FAIL历史

首次包测试中1项失败：故障注入“缺少本地回归依据”抛出了底层fixture missing，而负例要求AR12专用错误。改为统一、无敏感内容的AR12_REQUIRED_SOURCE_OR_PROOF_MISSING；后续102项与全仓1624项通过。初轮日志保留，未改矩阵或放宽N/A条件。当前未解决本地FAIL=0。

### BLOCKED

当前为35个外部环境/身份/部署/窗口/预算输入缺失，逐项提供方记录在admission.json与指南。旧可达性阻塞已由本次固定口径解决，不再要求提供虚构角色。如果源码/候选或本地回归依据变化，AR12重新评估阻塞自动恢复，不能沿用N/A。

### NOT_RUN与范围

- 全部44项目标用例（含AR12五个可达变体）、真实网关/Cognito/mTLS/S3/IoT/SQS/Outbox、目标日志和持久化验证。
- 原生DDB事务/TTL、多连接PG鉴权锁、真实跨库撤权与异常恢复、真实24h终态/目标容量与延迟。
- 完整verify/全Vitest/Playwright/构建/TS/CDK/目标迁移检查，按本批变更范围未执行。
- 真实云端调用、部署、目标库连接/迁移、设备/白名单启用、Git push：按用户边界未执行。
- 不可达单一分支单列NOT_APPLICABLE_SOURCE_BOUND，不能误报为以上任何一次目标PASS或简单NOT_RUN；G4仍NOT_RUN。

App/相机/队列/真机为第三方OUT_OF_SCOPE。

## 复验和下一步

新证据绑定ee27ed45参考提交、6dec1720应用候选、独立决策/源码/回归摘要及新protocolDigest，历史IMG-20/21/QA09证据不修改。源与artifact清单不自哈希，提交号由Git记录与最终回复给出。

```bash
node scripts/device-image-target-package.mjs --check
node --import tsx --test scripts/device-image-target-package.test.mjs
shasum -a 256 -c docs/audit/evidence/2026-11-08-AR12-acceptance/sources.sha256
shasum -a 256 -c docs/audit/evidence/2026-11-08-AR12-acceptance/artifacts.sha256
```

下一可执行任务：按35项输入的提供方补齐环境、身份、已部署版本及执行窗口；之后在明确授权下执行真实目标验收。单独的AR12口径不再需要制造新角色，也没有自动授权部署、迁移或启用设备。
