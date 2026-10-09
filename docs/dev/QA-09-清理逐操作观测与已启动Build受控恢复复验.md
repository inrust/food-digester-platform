# QA-09 清理逐操作观测与已启动Build受控恢复复验

依据：[b41b45c失败及清理关闭恢复](../audit/QA-09-b41b45c细分观测R0失败与清理关闭恢复-2026-10-09.md)、[ORM/pg细分复验](QA-09-ORM提交与pg结算默认关闭观测复验.md)。本轮只补本地验收执行器，不修改应用运行时、SQL、IAM/KMS、数据库连接预算或诊断开关默认值。

## 清理回执

child/parent增加`cleanupOperations`：顺序号、操作名、开始/完成时间、耗时、PASS/FAIL；错误只保存白名单code/name/cause、可验证格式的SDK请求ID、HTTP状态/attempts/retryDelay。CLI额外保存exitStatus、signal、spawnErrorCode、stderr字节数、耗时，不保存stderr/stdout正文、stack、SDK输入、SQL、参数、密码或Token。未分类错误为UNCLASSIFIED，不按字符串猜测权限拒绝。

HTTP保留既有逐请求传输与Gateway ID，外层操作回执标明具体清理步骤；数据库Build在调用前先写入action/receipt路径，失败也保留入口；桥接器保存`.preparation.json`、成功收到启动响应后的`.started.json`和所有CLI/read步骤。

Cognito GlobalSignOut、AdminDeleteUser、AdminGetUser分别执行并留痕。SignOut失败仍继续精确本轮身份删除与只读不存在核验，整体身份清理保持FAIL；没有会话时仅对账本身份使用AdminUserGlobalSignOut。GetUser的UserNotFound原AWS调用记录FAIL及`expectedOutcome=ABSENT_IDENTITY`，身份清理汇总才将其作为不存在的PASS证明。其他GetUser异常绝不证明不存在。写操作不自动重试。

## 已启动Build读取边界

收到Build ID后只读取这个ID；每次读取绑定项目、Build ID、NO_SOURCE、serviceRole、VPC、buildspec哈希、fixture源码哈希，以及唯一的PLAINTEXT `QA09_FIXTURE_HASH`和`QA09_FIXTURE_PLAN_B64`原始字节。JSON语义相同但Plan原字节不同、重复变量、错角色/源码/前缀/动作、失败终态或多个/失败结果frame均拒绝。

- 每个AWS CLI调用connect timeout 5秒、read timeout 10秒、进程上限30秒，AWS_MAX_ATTEMPTS=1。
- 启动后的轮询最多103次、17分钟；暂时读超时、已分类网络错误/限流/服务不可用最多额外恢复2次，每次2秒等待，复用既有轮询预算。
- AccessDenied、SSO过期、未知CLI_FAILED、无效JSON、绑定漂移立即失败，不重试。启动、项目更新、SQL、API写入和身份删除不纳入读取恢复。
- 结果日志继续使用既有最多15次/45秒可见性读取；每次CLI仍受30秒上限约束，墙钟预算到期前启动的一个在途请求可能越过外层截止时间。无框架或frame截断不等于SQL失败，原读失败仍保留。
- 在预算内读取恢复后，数据库回执`gate=PASS`仅证明原Build及其结果；`readGate=RECOVERED`、`originalReadGate=FAIL`和失败行保留。历史已失败child/parent不被重写，不由恢复单独取得R1准入。
- StartBuild响应丢失且无ID：FAIL/START_OUTCOME_UNCONFIRMED、startedBuildMayStillRun=true、READ_ONLY_DIAGNOSTIC_REQUIRED_NO_RESTART。不能假定未启动、重复start、虚构ID或选取共享项目“最近Build”；先只读确认唯一准确ID，否则夹具与配对Gate保持未闭合。

独立恢复命令（必须新输出文件）：

```sh
node scripts/recover-qa09-db-result.mjs ORIGINAL_BUILD_RECEIPT.json NEW_READONLY_RECOVERY.json
```

默认仅esgiot-readonly的STS/BatchGetBuilds/GetLogEvents，最多6次/90秒Build等待和2次暂时读取恢复，不StartBuild/StopBuild/UpdateProject、不重放SQL。原receipt与preparation哈希、恢复器及依赖源码字节保留。可选第三参数沿用历史已获取日志模式，明确标注不是新的独立读取，不能当fresh read。授权/SSO失败立即停止；只读结果不重写原业务Gate。

## 新SHA完整对照准入与顺序

1. 本地完整验证、离线失败矩阵和只读恢复通过后创建本地提交；人工通过GitHub Desktop推送。仓库AGENTS.md要求所有远程推送由人工完成。确认同完整SHA hosted CI、默认关闭部署、Amplify与19实际工件；禁止复用b41b45c的版本回执代替新SHA。
2. 使用全新证据目录和新前缀；重新核对可续期SSO及原手册的登录/角色清理余量、既有pool1连接预算和清理通道。source snapshots必须包含新bridge、started-build-read、operation-observation、frame-wait。
3. R0：engine=true、preconnect=true、account=false、detail=true、immediate；逐请求业务、6基线PATCH/19审计GET、最多12独立采样PATCH/18审计GET、12认证负向，遵循原输入及5ms严格门禁。完整业务、阶段、读恢复事实、清理、GlobalSignOut、独立空集和原设备/证书基线均闭合，才允许R1。
4. R1新前缀：只改变account=true；同SHA、同观测、同预算与次数，不造冷、不补样、不重放业务。共同BASELINE自然冷优先，缺共同基线才用共同独立采样，不混组。
5. 两组清理后同SHA关闭恢复：engine=true、preconnect/account/detail=false、immediate；19代码与非API revision不变、只读预算、数据库空集、归档零版本及原设备证书保持。
6. 任何原业务/清理/严格Gate失败，R1保持NOT_RUN，精确补偿后关闭恢复；补偿证明不能覆盖原FAIL。未知启动结果先确认终态和清理，再恢复，绝不为完成对照绕过失败。

```sh
node scripts/analyze-qa09-contract-load-detail.mjs --prepare PUSHED_FULL_SHA NEW_INPUTS.json
# 其余同SHA发布、19工件、阶段关联和匹配自然冷检查沿用ORM/pg细分复验手册。
```

本轮新SHA目标执行仍须取得真实回执；本地矩阵和旧Build只读恢复不能替代新前缀R0/R1。预算仍API512MiB/arm64/node24/reserved12、pool1、静态63/可用70、业务并发≤6；不更改IAM/KMS/容量、不发送邀请。TCP/TLS独立长尾、模型成本后移/收益/P95、独立设备HMAC/自然Active和完整QA-09维持原证据边界。
