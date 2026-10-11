# QA-09 Cognito安全分类与未知启动复验

本轮补清理诊断与只读取证，不改变候选默认关闭、数据库连接预算、业务请求数量或原始清理成功标准。[实施记录](../audit/QA-09-Cognito安全分类与未知启动实施记录-2026-10-11.md)、[本地证据](../audit/evidence/qa-09-safe-cleanup-implementation-2026-10-11/)。新版本目标验收当前为NOT_RUN，在人工推送后执行；历史`bc95e96`的失败、两次UNKNOWN与R1未执行保持原状。

## Cognito错误边界

`CognitoIdpError`继续使用现有封闭业务错误码。新增诊断阶段FETCH（取得Response前）、BODY（读JSON失败）、HTTP（非2xx服务拒绝）、REPLY（认证响应结构不符）。仅保存100～599整数HTTP状态、16～64字符十六进制/连字符请求ID和有限传输错误码；cause只保留一层`{code}`，不保留原异常、堆栈、URL、请求/响应体、用户名、密码或Token。

适配器不重试Cognito请求。错误密码与不存在用户仍统一INVALID_CREDENTIALS；不保存原服务异常类型或原始服务消息。成功GlobalSignOut的请求体、请求次数保持不变；损坏JSON不再被void操作误判为成功。未知字段或越界值丢弃，不能以消息正则提取业务凭据。

清理仍继续执行删除和UserNotFound空集检查，但GlobalSignOut失败必须使原始身份清理FAIL。独立空集PASS只能闭合残留，不得改写登出结果、子/父聚合Gate或解锁R1。

## 未知启动只读入口

```sh
node scripts/read-qa09-unknown-start.mjs <原FAIL回执.json> <全新取证回执.json>
```

原文件旁必须存在原始`.preparation.json`，不得改写二者，也不得生成假的`.started.json`。入口仅接受原FAIL、START_OUTCOME_UNCONFIRMED、唯一失败start-build操作且无已知Build的回执。sourceHash、buildspecHash、固定项目/角色、NO_SOURCE及原Plan字节均须匹配。

固定读取`esgiot-readonly`身份、该项目最新最多50个Build ID及其Build详情。不调用StartBuild、项目更新、IAM/KMS或SQL操作；不允许选择任意profile/项目/角色。总读取预算90秒、每次CLI最多30秒、全局最多2次瞬时失败恢复，原始失败保留；SSO过期、权限拒绝、非法JSON和未知错误不自动重试。

| 回执 | 后续行为 |
| --- | --- |
| UNKNOWN / NO_EXACT_BUILD_OBSERVED | 保留未知，不推断未执行，不重放原Plan |
| UNKNOWN / INVENTORY_WINDOW_INCOMPLETE | 保留未知，不以不完整清单选Build |
| BLOCKED / AMBIGUOUS_EXACT_BUILDS | 多个精确匹配时拒绝归属，不选择最近一条 |
| BLOCKED / EXACT_BUILD_OUTSIDE_START_WINDOW | 拒绝时间归属，不借用历史成功Build |
| UNAVAILABLE | 保留安全失败账本，不伪造0匹配或完整窗口 |
| RESOLVED | 仅确认唯一已有Build ID；executionGate/cleanupGate仍NOT_ASSESSED |

唯一匹配要求Build ID、buildspec、原sourceHash/Plan字节及变量类型/唯一性、角色、VPC、NO_SOURCE全一致。截断清单须覆盖启动前120秒边界，匹配Build必须位于原启动前120秒至原完成后30秒。只输出本轮安全结果，不持久化其他Build详情。CloudTrail未发现事件也不证明未执行。

RESOLVED后仅可用`readStartedFixtureBuild`继续读取该精确已有ID，再用`readVerifiedFixtureFrame`校验Build ID/sourceHash/prefix/action和原结果；禁止再次StartBuild。SUCCEEDED只确认Build终态，业务结果、清理各自仍需校验；FAILED/FAULT/STOPPED/TIMED_OUT不产生成功Gate。诊断恢复回执与原FAIL分别保存，不覆盖原始父子流程或将残留空集PASS转换成完整清理PASS。

## 新SHA执行序列

沿用[公开入口有界摘要复验](QA-09-公开入口日志有界观测接线与目标复验.md)的参数与阶段检查，先由人工通过GitHub Desktop推送实际本地提交。只用推送后的完整40位SHA生成输入和新证据目录：

```sh
node scripts/analyze-qa09-contract-observer.mjs --prepare <完整新SHA> <新目录/inputs.json>
```

1. 同SHA CI/默认关闭部署、Amplify及19工件通过；全部五个候选实际false。新SHA不能继承旧版目标PASS。
2. 入口核验可续期SSO、10分钟登录余量、75分钟角色清理余量及只读容量Gate。若StartBuild未知，先运行新的只读取证入口；未闭合不得自动换前缀再启动容量探针。
3. R0固定account/engine/preconnect/detail/public=true、observer=false；新前缀执行原有业务、6基线和最多12独立PATCH、自然冷、原始父子清理、独立空集、连接预算与阶段关联。任何原始清理FAIL或未知启动都阻止R1；允许在保留原FAIL后完成已有夹具清理和关闭恢复。
4. 只有R0全部阶段闭合才进入R1，另一新前缀保持同SHA、同预算和参数，仅observer=true。PATCH采集与检查加`--observer-cost`，审计GET保持原方式，禁止补样或人为造冷。
5. R1原清理及独立空集闭合后，恢复observer/public/detail/account/preconnect=false、engine=true；核对19工件、18个非API修订、实际配置、数据库/归档空集、预算及全部精确已知Build终态。
6. 若只读容量或最终核验UNKNOWN，保持相应阶段PARTIAL，不称完整对照成功。缺自然冷为NOT_OBSERVED，不能强行补请求。R0/R1输入兼容、单样本边界和摘要残差都不证明P95、compiler独占CPU或候选收益。

固定预算仍为ApiFn512MiB/reserved12/pool1、数据库静态63≤70、业务并发≤6；不扩容、不重启共享资源、不调整IAM/KMS、不发邀请。本轮HMAC/自然Active/邀请缺口不因该修复而闭合。TCP/TLS继续独立记录，不将Cognito诊断改善视为网络问题已修复。
