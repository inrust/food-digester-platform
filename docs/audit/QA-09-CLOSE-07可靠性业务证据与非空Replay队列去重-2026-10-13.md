# QA09-CLOSE-07 可靠性业务证据与非空 Replay／队列去重

日期：2026-10-13。依据[业务收口计划](../dev/QA-09-业务闭环优先收口计划.md)。先合并可靠性历史证据并核对版本，再补不依赖Active且现有权限允许的缺口。原失败、UNKNOWN启动和禁止重启约束保持。

## 版本与证据边界

受验应用 `dade6d950eb5fc681f9ab8c876762de5ffc77f4f`：CI [38250000748](https://github.com/inrust/food-digester-platform/actions/runs/38250000748)、部署 [38250000745](https://github.com/inrust/food-digester-platform/actions/runs/38250000745)均成功。19个Lambda工件与代码摘要/不可变S3 ZIP及Amplify同SHA核验PASS；仅复用仍严格匹配的历史已验证ZIP字节，当前配置和revision重新读取。

现有测试账号065986019555/ap-southeast-1，pool1/512MiB/并发12、五候选false。没有IAM/KMS/容量调整，没有生产操作、共享队列读取或Purge。验收工具源码独立冻结，不把其后续提交当作已受验应用版本。

[合并前账本](evidence/qa-09-close-07-2026-10-13/reconciliation-before-v2.json)绑定历史证据文件哈希及应用Git输入。525517a两个角色Replay只有空源sent=0；队列重投曾KMS拒绝，没有消费证明。0abf7cf旧执行器将原消息唯一误标为重投幂等，既有纠错回执明确撤销该结论；原文件均保留。历史导出租约恢复、非空ESG CSV与原文归档按原版本/配置/范围保留，相关应用输入已变，Replay/ESG-export/Archive/Ingestion四个实际部署工件与两组历史工件的8次比较也全部不同，不直接升级当前验收，见[版本绑定账本](evidence/qa-09-close-07-2026-10-13/reconciliation-version-bound.json)。旧业务FAIL与后续清理PASS分别记录。

## 原失败与有界功能执行修复

首轮 `qa09-7e66eb47eff01696` 在第二条Telemetry PUBACK等待10秒后超时。随后只读数据库确认该消息已PROCESSED，因此属于未获PUBACK确认，不能据此判定未投递，也没有重发它。清理登录刷新另有 `UND_ERR_CONNECT_TIMEOUT`；原业务FAIL及原读失败保持，未进入Replay阶段。

十证书/Thing、设备数据、四归档对象及两Customer、Cognito身份清理完成；[独立只读核验](evidence/qa-09-close-07-2026-10-13/first-final-readonly.json)确认数据库/六归档前缀/身份空集和6个精确Build均SUCCEEDED。该PASS只证明清理，不覆盖原失败。

收口执行器在每设备Telemetry首次发布前换新同身份MQTT连接，关闭自动重连；单次PUBACK功能等待有界45秒，超时不重发。既有十设备执行器默认仍为10秒。45秒只用于本轮业务功能执行，未改应用SLO、P95或原10秒失败。新的连接、晚拒绝、截止及清理所有权失败测试已补充。

## 本轮真实结果

第二轮使用全新前缀 `qa09-95b5944b32eaa370`，只在首轮独立清理闭合后启动。受验应用仍为dade6d95，未重启旧Plan、未重发首轮未知消息。[父流程](evidence/qa-09-close-07-2026-10-13/target-v2.json)业务与清理PASS；[专项原始回执](evidence/qa-09-close-07-2026-10-13/target-v2.json.reliability.json)保持PARTIAL，执行器最终退出码1。

| 验收项 | 结果与证明 | 范围限制 |
| --- | --- | --- |
| 非空Replay | PASS；真实POST 201，Job `af330954-7722-4842-9c63-d93a3688e1e1`，PlatformSuperAdmin；精确自有Customer、设备-03、Telemetry seq=1、原发生时间±1秒；COMPLETED，扫描10对象/10行，sent=1、skipped=9、失败全0 | 本轮未增加PlatformOperator非空Replay证明；旧空源角色证明保持原范围 |
| 重复消息实际消费 | PASS_EXACT_DUPLICATE_CONSUMPTION；Replay创建后观察到SQS ID `2853c67d-e14d-40e6-aaff-ea06e95cef5b`，root DUPLICATE_SKIPPED/ROOT_TRANSACTION_COMPLETED及最终PROCESSED；相同原消息、设备、receipt与Lambda invocation | Replay生产者没有输出/返回SQS ID，因此不声明Job→该唯一SQS ID的直接生产关联；不冒充直接SSO重投成功 |
| 直接SSO队列重投 | BLOCKED_PERMISSION_NO_RETRY；一次SendMessage返回KmsAccessDenied，未取得MessageId；消费Gate NOT_RUN_NO_SUBMISSION | 未重试、未请求或调整KMS权限，没有ReceiveMessage/Purge或共享队列操作 |
| 非空小时/归档去重 | [独立限定范围评估](evidence/qa-09-close-07-2026-10-13/hourly-dedup-assessment.json) PASS_HOURLY_ARCHIVE_DEDUP_SCOPE：前后30原receipt、10 hourly、20 ARCHIVE outbox行数/摘要及原receipt完整内容不变；范围外设备/证书摘要保持；20原始Telemetry归档哈希均验证 | 原四表全非空dedupGate仍NO_RECEIPT，没有放宽原Gate。daily前后均0行，仅证明空集未变，NOT_RUN_NO_DAILY_ROWS；不证明日报/ESG计算一致性 |
| Replay审计与专项清理 | create/execute SUCCESS审计PASS；Replay Job/outbox自有业务清理及独立业务审计PASS | 不升级历史原FAIL/UNKNOWN |
| 父清理与最终核验 | 十证书/Thing、十设备、归档版本、两Customer软删除及身份撤销/删除PASS；最终独立只读核验见下 | 原失败另列，清理PASS不能覆盖业务缺口 |

日报由summary-worker周期汇总，摄入只写小时桶。本轮没有为制造日报调用共享汇总任务或SQL播种数据；当前版本导出租约恢复、日报/归档/ESG完整一致性继续保留单独待验项。[合并后账本](evidence/qa-09-close-07-2026-10-13/reconciliation-after.json)保留历史和本轮原Gate，避免把局部证明计为完整可靠性验收。

2026-10-13T00:39:49.634Z，[最终独立只读核验](evidence/qa-09-close-07-2026-10-13/final-readonly.json)PASS：数据库自有设备/证书/接入数据空集、原范围外指纹一致，六S3前缀Versions/DeleteMarkers均0，专用Cognito用户0，12个精确自有Build均SUCCEEDED。只读启动已知且终止，无新UNKNOWN，没有业务写入。

最终19工件及[实际配置](evidence/qa-09-close-07-2026-10-13/api-final-config.json)PASS，五候选false、pool1/512MiB/并发12及既有engine诊断配置保持。新验收工具提交不等于应用重新部署；本轮受验应用始终为dade6d95。

## 实现、测试及Gate

新增合并器、非空Replay/精确队列专项执行器与固定元数据Gate；既有十设备执行器增加可选内存发布hook和未知/运行中可靠性写入的清理保护；数据库夹具新增强制READ ONLY的可靠性观测，不播种Active或绕过认证。

变更文件：`scripts/qa09-ten-device-db.mjs`、`scripts/run-qa09-ten-device-acceptance.mjs`，新增可靠性合并器/执行器/最终只读采集器、可靠性Gate与测试、限定小时去重评估器与测试；新增本报告、复验手册与证据目录，更新业务收口计划和管理后台任务清单。没有修改应用、契约、迁移、依赖锁文件或基础设施。

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test scripts/*.test.mjs` | 1329 PASS、0 FAIL、0跳过；[完整日志](evidence/qa-09-close-07-2026-10-13/local-tests-complete.log) |
| `node --import tsx --test scripts/qa09-reliability-closeout.test.mjs scripts/qa09-ten-device*.test.mjs` | 专项26 PASS；覆盖只读SQL真实执行/所有权、跨消息/调用伪关联、空Replay/摘要漂移、未知提交不重试、分页/总时限、连接失败/晚拒绝及清理未知启动保护；实际文件列表见专项日志 |
| `node --import tsx --test scripts/qa09-replay-dedup-assessment.test.mjs` | 2 PASS；限定小时证明与原Gate分离，拒绝缺失/重复/范围外/摘要变化 |
| `node --import tsx scripts/run-reliability-suite.mjs <证据目录>/local-reliability.json` | 2 PASS、清理PASS；仅LOCAL_LOAD_RELIABILITY，原AWS Gate保持未执行，不升级目标结论 |
| `node node_modules/eslint/bin/eslint.js <本次9个脚本>`；`node node_modules/prettier/bin/prettier.cjs --check <本次9个脚本>` | PASS，命令路径列表见lint/format日志 |
| `node scripts/check-boundaries.mjs`、`node scripts/check-schemas.mjs`、`node scripts/check-migrations.mjs` | PASS |
| `node --import tsx scripts/run-qa09-reliability-closeout-target.mjs <证据目录>/target-v2.json <证据目录>/application-version.json`（显式绑定SHA/部署ID） | 退出1，原始专项PARTIAL；父业务/父清理PASS，权限/日报缺口保留 |
| `node scripts/qa09-replay-dedup-assessment.mjs <证据目录>/target-v2.json <证据目录>/hourly-dedup-assessment.json` | 退出0，限定小时/归档去重PASS，完整QA-09仍false |
| `node --import tsx scripts/collect-qa09-reliability-final.mjs <证据目录>/target-v2.json <证据目录>/final-readonly.json` | 退出0；数据库/归档/身份空集、12个精确Build终态PASS |
| `python3 docs/audit/evidence/qa-09-close-07-2026-10-13/verify.py`、`node scripts/check-secrets.mjs`、`git diff --check` | PASS；历史封存、冻结源码与本轮内容摘要核验，完整性PASS不能替代业务PASS |

封存校验首次直接重定向到扫描目录的JSON，因先创建空文件导致JSON解析失败；原空输出及失败记录保留。改为进程内捕获成功输出后写入，再对最终封存复核；没有云端动作或历史回执改写。

**Gate：QA09-CLOSE-07 PARTIAL；QA-09 PARTIAL；fullQa09Accepted=false；productionReady=false。** 非空Replay、精确重复消费、限定小时/归档去重、审计与清理按上述范围计入；直接重投BLOCKED、日报/ESG一致性/当前导出租约及唯一生产关联未闭合。首次PUBACK失败、清理刷新读失败及历史未知Plan原样保留、禁止重启。详细性能继续REL-PERF-01 DEFERRED_TO_RELEASE / NOT_ACCEPTED。

下一可执行任务：补当前版本的自有导出租约恢复与日报/归档/ESG一致性，补Replay生产者唯一消息关联及PlatformOperator非空路径；在现有权限内实施，不处理KMS运维授权。CLOSE-08可先映射正式回执，不能提前关闭QA-09。复验命令和停止条件见[手册](../dev/QA-09-非空Replay与精确队列去重复验.md)。
