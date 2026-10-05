# QA-09 fb0fd67 真实 RECEIVED 与阶段性能复验（2026-10-05）

**本轮真实 RECEIVED、正常窗口两项 SLO、阶段观测及清理均通过；完整 QA-09 保持 PARTIAL。** 受验 AWS 应用 SHA 为 `fb0fd67cb19b9160f9260f49e370e05304ca37a0`，新前缀 `qa09-90de5a6bdd5d57b2`，账号065986019555、ap-southeast-1现有测试环境。没有IAM/KMS调整、容量调整、共享队列读取或清空。

[CI 37249156131](https://github.com/inrust/food-digester-platform/actions/runs/37249156131) 与 [Deploy 37249156121](https://github.com/inrust/food-digester-platform/actions/runs/37249156121) 同SHA完整验证及部署成功，Amplify也为同SHA成功。19/19不可变Lambda ZIP字节摘要与现场CodeSha256匹配；全部清理后再读19个代码摘要、Revision和runtime配置，19/19完全一致。原811d84e付款阻断、四次超时失败及修复报告均保留。

## 真实验收结果

| 子范围 | 证据 | Gate |
| --- | --- | --- |
| 十设备CSR/MQTT/mTLS | 10组本机私钥与CSR签发证书匹配；10个独立MQTT会话、Heartbeat与10个mTLS HTTP200；跨设备订阅/发布和不受信客户端拒绝通过 | PASS |
| 基线入库/归档 | 30条唯一PROCESSED、每设备2条基线Telemetry；20条基线Telemetry S3原文/规范哈希核验，读取探针删除、角色策略保持 | PASS |
| 自然Assigned→Licensed | 专项设备-01在issue/activate后分别Sync、发送RECEIVED；两次HTTP200，绑定/完整签名载荷存在，管理员回读Licensed | PASS |
| 自然Licensed→Active | 无设备独立HMAC配置；未发送VERIFIED、未SQL播种Active | NOT RUN |
| 正常窗口Telemetry API可见 | 新20条全部可见；P95 **1683ms≤5000ms** | PASS |
| 在线Command | 20条FORCE_SYNC全部收到；同客户端单调时钟API开始→MQTT回调P95 **802ms≤3000ms** | PASS |
| Telemetry/API阶段 | 固定元数据967行，10000…10019全部具备根事务完成、具体SQS最终处理及聚合/归档Outbox阶段；console查询有观测 | PASS_SCOPED_STAGE_EVIDENCE |
| Command发布阶段 | 20命令、160行；五个发布阶段、PUBLISHED消费和关联invocation SQS阶段齐全；全部warm | PASS_SCOPED_COMMAND_PHASES |
| 自有SQS重投 | KMS.AccessDeniedException，未取得提交ID或消费证明；没有修改Key policy | BLOCKED |
| 精确清理 | 父驱动209断言PASS、15清理PASS；业务/站点清理PASS；120个raw归档版本及6个license域版本删除、域剩余0；原设备2/证书3指纹保持 | PASS |

RECEIVED证明经真实mTLS认证的接收声明，服务端验签/固件独立验签不能相互替代。Licensed仅在专项设备-01验证，不宣称十设备全部完成该状态迁移。本轮正常窗口20样本不替代完整MQTT速率或24小时试运营。S3原文核验对应基线20条；正常窗口新增20条证明唯一处理及归档Outbox阶段，没有重新执行新增20条全量S3原文验收。Command接收时钟不包含执行完成/ACK端到端SLO。

## 阶段诊断的实际边界

正常窗口Telemetry阶段20样本P95/max（ms）：根事务782/1238、事务回调660/1175、business200/440、gap180/299、聚合137/340、归档Outbox100/140。Console-read共54次查询，P95/max153/739；各并行查询可能共用pool1等待，不能将各阶段相加。

Command阶段20样本P95/max（ms）：validation3/16、lease140/160、attempt14/20、IoT发布41/140、finalize119/139、SQS消费302/487。SQS消费是invocation/batch范围；本轮可通过commandId→具体消费→lambdaRequestId关联，仍不当作纯队列等待。没有冷启动样本，不能证明冷启动SLO或512MB的独立因果收益。

事务时间可能包含连接等待、BEGIN/COMMIT、调度和查询；外层与回调差值不是纯连接池等待。原receipt.processedAt为创建时点，阶段证据使用明确ROOT_TRANSACTION_COMPLETED和具体SQS disposition。保留旧正常窗口7635ms FAIL，本轮1683ms PASS是新的独立样本，不改写旧测量，也不足以证明长期性能或单一修复的因果效果。

## 本地只读采集器修复与失败证据

现场一页诊断发现427条已识别event全部在投影中丢失：封闭事件名含点号，却被用于普通ID的正则过滤。新增真实序列化日志→投影→20序号Gate回归在旧代码失败（2 FAIL/2 PASS），修复只直接保留已校验的三种event枚举，其他字段/未知事件仍按原规则拒绝。修复后4/4专项及全部脚本467/467 PASS。

这项仅是本地读取工具修复；AWS应用/工作流/IaC/契约均未改动，不需要冒称另一个应用SHA。原执行器源在normal.json.sources.json中冻结，修复后的实际源和SHA在stage-collector-source.json中保存。失败诊断和before/after日志均保留。

本轮Command只读采集首次将20个请求ID拼入一个过滤式，超过AWS返回的1024字符限制；原脚本和失败回执保留。最终每批最多10个ID、最多20次日志读取、最长6小时窗口，按本轮commandId及关联SQS/requestId投影固定元数据后PASS。没有因此重发命令、扩权限或归档原始日志。

## 可重放证据与命令

全部回执、执行源、前后失败及清理记录见[本轮证据目录](evidence/qa-09-fb0fd67-target-2026-10-05/)与summary.json。使用Node24.12.0，设置完整QA09_EXPECTED_COMMIT及QA09_DEPLOY_RUN_ID=37249156121：

- `node scripts/collect-qa09-application-version.mjs <application-version.json>`：exit0，19工件PASS。
- `node --import tsx scripts/run-qa09-normal-slo-target.mjs <normal.json> <application-version.json>`：exit0，PASS_SCOPED_NORMAL_WINDOW_SLO及完整自有清理。
- `node scripts/qa09-data-path-evidence.mjs <normal.json.probes.json> <application-version.json> <data-path-stages.json>`：修复后exit0，20序号阶段PASS。
- `python3 <本轮目录>/collect-own-command-phases.py`：最终exit0，20命令阶段PASS；原失败日志保持。
- `node scripts/collect-qa09-application-version.mjs <application-runtime-version.json> --runtime-only`：exit0，19运行时健康及与原字节回执无漂移比较PASS。
- `node --test scripts/qa09-data-path-evidence.test.mjs`：修复后4/4 PASS；`pnpm test:scripts`：467/467 PASS。GitHub同fb0fd67的`pnpm verify`两次PASS；本地采集器修复不宣称已经在该远程SHA执行。

## 剩余风险与下一可执行任务

完整QA-09仍PARTIAL：设备独立HMAC/自然Active、Command冷启动、特定SQS重投、全业务合法写入/117项语义行为/浏览器目标回执、完整24小时负载及八套正式领域证据仍未全部闭环。IAM/KMS运营事项由管理员处理，本轮不重复提出权限补丁。

下一可执行任务是继续补目标环境全业务合法写入和117项语义/浏览器E2E回执，可先开展不依赖自然Active的分支；需要Active的真实路径保留验签器前置。阶段证据已可用于后续负载诊断，预算不因本轮小样本PASS而扩大。记录本地采集器修复与审计提交，不主动推送。
