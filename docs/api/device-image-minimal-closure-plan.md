# IMG-21 单设备受控入口、验签通道及候选绑定最小补齐方案

2026-11-08，基于 main `91604a70`。这是本地设计与参考验证交付，**未授权或执行部署、IAM变更、资源创建、设备启用及真实G4传图**。应用候选仍为d1a7b811，G3证据为1b1b879f；当前实际准入11/22、G4 NOT_RUN不变。App/真机不是前置。

推荐增加两个**无公网入口、按数字版本调用的独立测试Lambda**：单设备权威写Worker、License验签Worker。复用现有数据库/网络/Secret/CONTROL表/业务API；不新增数据库表、公开HTTP API、共享环境或业务迁移。版本问题优先走经审查的应用源等价绑定，保留真实已观察部署69c76e1d，不伪造d1部署。新增测试工具有独立代码、配置、角色和本地门禁，不能冒充由应用G3一并认证。

[机器计划及IAM草稿](../audit/evidence/2026-11-08-device-image-minimal-closure/implementation-plan.json) · [源比较](../audit/evidence/2026-11-08-device-image-minimal-closure/version-analysis.json) · [本地参考代码](../audit/evidence/2026-11-08-device-image-minimal-closure/prototypes/reference-guards.mjs)。参考代码没有handler、AWS/DB客户端或部署入口，不是可用的目标Worker。

## 1. 可复用资源与不可直接复用项

以下目标定位来自11月8日已保留的只读记录，本轮未重新访问AWS，实际实施前必须复核。

| 资源 | 复用方式和限制 |
|---|---|
| fdp-test-app / 065986019555 / ap-southeast-1 | 保持现有应用、V1权限矩阵、20个应用函数；不借方案重部署全部应用 |
| VPC vpc-0d287fdfa0a4a06bd、两个现有私有子网 | Writer置于既有网络；复用已允许到RDS 5432的执行器SG，候选sg-056df8dcb3fe75dcb，实施前核对规则及出站443。无需新增公网入站、NAT或VPC；不满足则BLOCKED，不自动改网络 |
| RDS fdp、既有44项迁移/61表 | 复用schema、users/user_roles/user_scopes/device_live_image_policies、audit_logs；W06已证明只读迁移记录/表存在，未证明新写入口正确 |
| 既有RDS Secret | 仅Writer角色可读；不复制密码到本地、普通环境变量、Git或回执。数据库凭据本身仍有较大SQL权限，IAM不能按SQL行隔离；单设备限制依赖固定代码、DB所有权检查和发布权限隔离 |
| CONTROL/PAYLOAD | 沿用两表名。Writer只读CONTROL元数据、条件写本轮一个DEVICE#UUID分区；不授予PAYLOAD访问。env仍必须同时设置两个表名，避免createPreviewAwarePrismaClient缺配置退回旧client |
| Cognito User Pool ap-southeast-1_hZMX8LpFo及现有组 | 沿用CustomerViewer及审批用PlatformSuperAdmin，无新角色、无矩阵修改；最多本轮两个用户名，SUPPRESS通知。Writer仅查询这两人的元数据/组，创建/密码/组写仍由已批准的协调步骤承担 |
| LicenseSigningKey及既有dataKey | Secret参考为fdp-test-license-signing-key-OVgupB，源码确认使用同一dataKey加密；仅独立Verifier可GetSecretValue/Decrypt，不授权Writer、协调机或查看者读取License key |
| 现有Onboarding、分配、License、Sync、MQTT | 正常CSR签发、首Heartbeat、分配、License RECEIVED/VERIFIED进入Active，不手工写生命周期/运行状态，不用旧前缀绕过验证 |
| audit_logs | 复用主键和JSON字段存run根记录、绑定和操作收据，不迁移新表；写业务数据和成功操作收据同一PG事务，存public ID/Hash/状态，不存凭据、完整License签名或图像本体 |
| 现有只读作业 | 只做原生核验；默认buildspec漂移不变，不改为通用写作业 |

旧ten-device-fixtures要求qa09十设备计划且使用裸SQL；first-admin bootstrap要求空用户库；二者均不可直接用作本轮Writer。旧验签器只接受qa09/syncprobe，所需专用角色也不存在，不能伪造序列号或把“role not found”当成功。

### 为什么选择私有Lambda

复用CodeBuild加任意buildspec覆盖虽然少建函数，却让可StartBuild的调用者有机会换代码并读取DB Secret；“源码Hash写在说明里”不能形成受控边界。最小可信入口采用固定代码、固定配置、仅数字版本ARN可Invoke，部署身份与执行身份分离；执行者不能UpdateFunctionCode/Configuration、PublishVersion、PassRole、修改角色/边界或StartBuild任意代码。

拟新增：2个函数、2个执行角色、2份专用权限边界、2个日志组。Writer并发1、FDP_DB_POOL_MAX=1，事务timeout 10000ms/maxWait 1000ms；部署前确认源码连接预算及目标实际余量至少容纳1条额外连接，保留运维余量，不能挤占现有应用预算。Verifier无DB、无VPC、并发1，按需读取一个Secret。均不配置Function URL、API Gateway、定时触发或异步自动重试。

## 2. 必要代码及闭合操作契约

以下为下一批实现路径建议，**本批未实现目标handler或接入现有部署入口**。

| 建议文件 | 必须实现的行为 |
|---|---|
| tools/img21/controlled-writer.ts | 封闭操作表、固定run根、事务内真实所有权读取、createPreviewAwarePrismaClient、审计幂等收据和未知结果查询 |
| tools/img21/run-ledger.ts | audit_logs中确定性run/operation主键；不可变device/customer/certificate绑定、expected authEpoch、完整请求Hash；拒绝同operationId不同内容 |
| tools/img21/license-verifier.ts | exact run/serial/model/device/customer/certificate/license/version/snapshotEtag/nonce/期限绑定，先校验后读Key，匹配DEC-020规范载荷 |
| tools/img21/coordinator.ts | Cognito两个身份及常规业务API调用；凭据仅私密区；使用既有CSR，记录真实响应ID；先建可用DB入口再建身份，禁止孤儿特权账号；只在获批范围/窗口内运行 |
| 独立测试工具CDK entry/stack | 两个私有函数、版本、角色/边界/日志、网络导入、并发/连接预算、Phase A/B策略；与现有app入口分离，不默认为全应用部署 |
| scripts/device-image-target-package.mjs及其测试（后续） | 增加显式version-proof v2/审查后的源等价模式和独立executionTools清单；旧严格模式保持默认。不得只改旧SHA/布尔值来通过 |

若新增workspace、锁文件、共享模块或现有infra入口会改变应用构建输入，必须重新冻结候选、跑适用G3并重新绑定。工具隔离只有在构建输入/asset清单证明未进入20个应用制品时成立，不可随意忽略整个infra/scripts目录或扩大现有20项准备文件豁免。

### Writer输入与动作

公共输入仅允许runId、manifestHash、operationId、action及该动作必要的userId/deviceId/expectedAuthEpoch；未知字段、sql、任意data/where/role、批量ID均拒绝。manifest须来自已发布版本的受信配置/固定摘要，不能接受调用者自填approved=true作为授权。测试参考函数的spec/facts是本地端口参数；目标facts必须由Worker的PG/Cognito读取，绝不能从请求直接接收。

| 动作 | 事务/所有权规则 |
|---|---|
| SEED_PROVISIONER | 仅本轮Cognito返回的sub、固定用户名、PlatformSuperAdmin单一组；验证该身份刚创建且无既有租约；按现有INVITED→首次登录激活流程，不复用旧用户、不使用first-admin CLI |
| SEED_VIEWER | 仅固定CustomerViewer用户名/sub，scope只能为本轮已绑定客户；不得追加第二租户/角色 |
| BIND_DEVICE | 正常API创建设备后，以精确serial查询，核实本轮审批actor/audit、客户/站点来源记录及证书CSR公钥；同事务写一次不可变binding。不能仅凭名字前缀认领既有设备，不能重新绑定另一个ID |
| ENABLE_PREVIEW | device/customer/serial/certificate及authEpoch一致，lifecycle/operational为Active或Maintenance，证书当前有效；仅该ID policy upsert，通过现有失效协议关闭CONTROL、加epoch、SQL提交后复核恢复；不接受任意DDB Item |
| DISABLE_PREVIEW | 仅本轮绑定ID、当前归属/代次一致；经同一包装器关闭，不删CONTROL、不恢复旧租约、不倒退epoch |
| DISABLE_IDENTITY | 仅run账本内两个用户；PSA不得持有外部设备租约，Viewer scope始终只含本轮客户；外部租约/范围漂移则停止，不触碰他人控制记录 |
| READ_OPERATION | 只读查询本轮operation及事实，用于明确写结果；不得借此查询他人数据或自动重做UNKNOWN写 |

业务写与audit收据在一个PG事务中提交，成功收据包含requestHash、结果ID及前后代次；UUID/文本主键确定性派生并检查唯一冲突。同ID同Hash返回原结果，异Hash冲突。跨PG/DDB没有原子总事务：SQL回滚时允许CONTROL保持关闭；SQL提交后恢复失败必须记录SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED，不能谎称SQL回滚。UNKNOWN先查收据及事实，不自动重试；显式恢复先重新鉴权和核对版本。

### CONTROL权限中的实际限制

现有withLiveImageAuthority在用户/角色变更时，会枚举已配置预览策略的设备并GetItem检查actor租约。本地PGlite+真实包装器回归已验证：创建一个新用户会读取本轮及其他设备的CONTROL元数据，但没有相关租约时不写其他设备。

最小复用方案因此需要CONTROL表范围GetItem元数据读取；只将PutItem限为本轮一个分区，不访问PAYLOAD图片。不得把方案描述为“IAM所有读写都只有一个设备”。这是明确的元数据读范围，需要未来权限审查接受。若不接受，需另外改造通用鉴权包装器、证明不会漏撤外部租约，并重跑应用G3；不属于当前最小方案。

IAM LeadingKeys约束分区键，不能独自限定sk=CONTROL、SQL行或JSON内容；固定handler/传输端口必须把sk及字段固化。SQL事实读取/全局排他屏障/用户设备行锁/CONTROL CAS均沿用现有协议，不能另建未包装client。

## 3. 两阶段权限与验签通道

[iam目录](../audit/evidence/2026-11-08-device-image-minimal-closure/iam/)是**未应用模板**，含未解析的UUID/版本/窗口字段，不能直接提交AWS。

| 主体 | 最小授权 / 禁止项 |
|---|---|
| Writer Phase A | 单一RDS Secret GetSecretValue、限定dataKey且ViaService+SecretARN的Decrypt；User Pool的AdminGetUser/AdminListGroupsForUser；CONTROL GetItem；自身日志。无PutItem；先创建无租约的新身份并记录真实binding |
| Writer Phase B | 在A上仅增加CONTROL PutItem，ForAllValues:StringEquals LeadingKeys为DEVICE#实际server UUID，Null=false。绑定后才渲染策略；不能用img21序列号前缀或*，不授予DeleteItem/UpdateItem/Scan/PAYLOAD权限 |
| Writer VPC | AWS要求的6项ENI操作需要Resource=*；与lambda:SourceFunctionArn显式Deny配对，阻止函数业务代码调用EC2，而保留Lambda服务管理ENI。无新公网入站 |
| Verifier | 单一License Secret GetSecretValue、仅该Secret加密上下文的dataKey Decrypt、自身日志；无DB Secret、DynamoDB、Cognito、IoT、KMS Sign/GenerateMac、角色切换或返回密钥 |
| 协调执行者 | 仅两个函数已发布数字版本ARN的InvokeFunction，受新批准窗口Date条件限制；不使用$LATEST或可移动alias，不拥有源码更新、PassRole、边界修改或Worker角色AssumeRole权限。既有Cognito/业务权限仍仅用于本轮两身份/资源；IAM Pool授权无法替代代码中的用户名校验 |
| 部署/IAM操作者（以后另批） | 仅本方案两个测试函数、两角色/专用边界/日志的创建发布与配置，及Writer Phase B单项策略更新；PassRole只限两角色且PassedToService=lambda.amazonaws.com。不得扩大现有Service/Migration边界、复用应用执行角色、改19个应用DB Lambda或开放通用StartBuild。实际effective permission和boundary内容必须复核，不能只凭本地inline JSON认定可用 |

只读核验继续使用既有ReadOnlyOps：实施前核对新函数配置/运行时、角色/策略/边界、日志及Secret版本元数据的读取权限；不足时单列只读增量评审，不能假设原策略一定覆盖新资源，也不能向协调机开放GetSecretValue。

Writer专用boundary含CONTROL PutItem上限，但boundary是权限上限，不会让Phase A自动获得写授权；真正授权来自Phase B的单UUID条件策略。专用boundary同时容纳必要ENI动作，避免为新工具修改现有全局边界。日志组由部署者预建，运行角色只有自身日志流写，不授予CreateLogGroup或读他人日志。

### 部署控制面的必要增量

仓库的FDP-DeploymentBoundary和FDP-CloudFormationExecutionPolicy都含DenyWrongServiceBoundary，原fdp-test-*根路径角色仅允许Service/Migration两种边界；管理策略的授权也只列MigrationBoundary。只给新角色inline权限仍无法创建新专用边界。

最小控制面草稿见iam/deployer-delta.template.json：新角色使用明确的/img21/路径，各自只能绑定FDP-IMG21-WriterBoundary或FDP-IMG21-VerifierBoundary，增加对应的显式错误边界Deny；现有根路径Deny及Service/Migration运行边界保持不变。向上述两份控制面策略分别增加精确的两角色/两边界资源授权，PassRole只到Lambda，不增加任意role/policy通配管理。路径不是免边界机制，新路径同样有一对一显式Deny。新运行角色/边界按审计保留，不能以删除边界绕过既有全局Deny。

InfraSetup bootstrap策略源码已允许管理这两份控制面策略，但目标effective permission、boundary及SCP仍须另行复核；本轮未查看或修改实际策略。现有Lambda/日志管理范围若不覆盖新函数，也应列精确缺项，不自动加宽现有fdp-test-*。

修改上述纳入交付清单的IAM源码会破坏对新仓库候选的1693份完全相同结论，需要新候选G3及版本绑定重新评审。当前源等价分析只对已比较的69↔d1成立；独立工具候选可分开记录，不能将控制面差异静默从1693中剔除。若以后要允许纯控制面差异，应新增明确的构建依赖/政策差异绑定模式和负例，不能假称本轮推荐模式已覆盖该情况。

已发布Lambda版本固定代码和大部分配置，但不会冻结角色策略，运行时Auto管理也可能更新；实施须固定/复核运行时版本或选择FunctionUpdate管理，并记录CodeSha、配置Hash、角色/边界政策版本Hash和部署回执。仅数字版本ARN不等于所有运行依赖永远不变。[AWS版本说明](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html) · [ENI与SourceFunctionArn](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html) · [LeadingKeys约束](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)。

### Verifier具体规则

Verifier在真实device/customer/cert绑定后才发布相应版本/配置。复用现有License Secret的指定版本，不新建或复制Key；目标适配器先核对自身角色、固定Secret ARN/允许VersionId、run manifest和当前请求，再读取Key。支持当前已声明签发版本；轮换期间如需previous版本必须额外精确列明，不尝试所有历史Key，不接受legacy裸MAC。

角色核验应在调用前读取已发布版本配置和策略，与运行时context.invokedFunctionArn/版本核对，不能假设Lambda有aws CLI。若后续选择STS自检，须显式声明SDK依赖，并将lock/构建输入变化纳入新候选验证，不偷偷使用未打包工具。

验证固定六字段顺序、完整UTC instant、wire entitlement排序、签名v1/Base64URL、license/version/effective及payload设备客户一致；请求绑定serial=img21原值/model，不把它改成syncprobe。nonce为32字节随机值的hex，TTL最长5分钟且不得超过批准窗口；回执绑定候选/工具版本、manifest、device/customer/cert、license/version、snapshotEtag、nonce和截止，只返回验证结论及摘要。使用timingSafeEqual，不输出Key、完整签名、Token或许可原文。

该通道是只读验签，nonce用于短期请求/响应关联；同输入复验可幂等，不宣称跨实例nonce只能消费一次。若要全局一次性nonce，需另加持久状态及权限，不伪装为当前无DB/DDB设计已有。协调器核对新鲜snapshot/cert/nonce后才发送正常Sync VERIFIED，服务端已有快照/收据幂等约束继续有效。

Buffer尽量在finally清零，SDK SecretString引用及时释放；JS不可变字符串不能保证物理擦除，不能宣称绝对零内存残留。Key不得通过本机/协调器或公开接口输出。当前参考代码只用合成Key，并与实际cloud signer作正向格式对照，未读取真实Secret。

## 4. 候选版本绑定

本地重新比较结果：1693份交付源差异0；apps/packages/contracts/infra及4项根构建输入树一致。1713份完整验证输入中有12份准备工具/元数据不同，不能声称完整仓库/验证输入全部相同。保留的20个应用函数Hash匹配69制品，只是历史目标观察，本轮没有新目标读取。

| 方案 | 适用与代价 |
|---|---|
| 精确部署d1或新候选 | 保持现有strict校验；需另批应用发布，并验证全部权威入口/窗口。不在本轮执行 |
| 推荐：经审查的应用源等价 | applicationCandidate=d1，observedDeployedCommit=69，二者都保留；比对完整固定源/构建输入、所有差异、制品来源和新目标快照后接受明确的等价绑定。不把69改名为d1，不等于假设重建字节一致 |

后续proof v2建议包含bindingMode、applicationCandidate、observedDeployedCommit、sourceManifest/差异分析Hash、reviewDecisionRef、部署CI/固定S3 VersionId/Size/FULL_OBJECT SHA256来源、20个应用函数新鲜CodeSha/RevisionId/配置、19个应用权威入口表配置，以及executionTools单独清单。新Writer也是权威入口，必须另列，不得只看原19个便声称“所有写入口已验证”；Verifier也要记录工具sourceCommit、数字版本、CodeSha、配置、角色策略及本地门禁。

等价评审必须重新从Git/固定来源复算，不信任一份手填changed=0或approved=true。加入/删除应用文件、IAM/构建配置变化、新工具进入应用asset、运行时/环境差异、任何一个制品Hash不符或目标观察不在批准窗口，均应拒绝/重做G3，不能扩大豁免清单。运行Git commit仍如实显示69，允许的元数据差异需明确列出，不能拿源码相同代替部署制品来源。

**当前等价模式未启用、未获准接受**；本地测试确认现有cloudAdmission仍拒绝历史release部署证明，默认严格模式未削弱。先落定模式、实现负例及重新生成协议，再提交接收该模式的评审；本地文件校验上限仍是结构校验，不会产生G4 PASS。

## 5. 实施顺序与验收条件

| 阶段 | 具体步骤 | 放行条件 |
|---|---|---|
| MC01 本地实现 | 完成Writer/ledger/Verifier真实handler、封闭请求、打包及SDK适配；参考代码只作约束样例 | 所有权/越权/重放/Hash/代次/UNKNOWN/回滚/提交后恢复失败测试；合成Key正负向及先校验后读Key；构建制品和源码Hash齐全 |
| MC02 IaC/权限 | 独立工具栈、本地synth/策略检查、连接预算、固定版本调用、Phase A/B模板渲染、网络导入 | 新增资源/权限清单可审查；Phase A无写、Phase B仅真实UUID、无PAYLOAD/任意SQL/全局边界扩张；未授权不得deploy/apply |
| MC03 版本绑定 | 评审exact或equivalent；实现proof v2/独立工具版本清单、保留旧严格模式及失败历史 | 源/构建输入/制品/运行配置反例均拒绝；必要时新候选和完整G3；当前11/22不自动变满 |
| MC04 另批部署A | 在新窗口部署Writer Phase A，固定版本和政策Hash；再创建两个自己的Cognito+DB身份 | 目标证明无孤儿账号、旧账号复用或未包装写入；异常回滚/收据/跨租户拒绝可验证 |
| MC05 正常准备 | API创建客户站点、CSR审批签发/首Heartbeat/分配；BIND_DEVICE写不可变run绑定；发布含真实ID绑定的Verifier | 精确CSR公钥/证书/serial/customer匹配、IAM实际Key读取路径及无泄漏验证通过；不手改Active |
| MC06 授权B | 以真实UUID渲染/审核单项PutItem条件，正常License Sync到Active，启用唯一设备预览 | 原生锁/CONTROL fence/后提交恢复可观测；其他分区写实际AccessDenied，PAYLOAD实际AccessDenied；权限模拟或本地快照不替代实际结果 |
| MC07 G4与清理 | 单独允许真实传图后用模拟客户端跑CF01/02/03，读回JPEG/Hash、登记关联；关闭并停用本轮资源 | 三链路真实证据、版本/范围/有效窗口及清理完成即可G4；不等待App、真机、扩展44项、24h或容量SLA |

旧20:41:58～22:11:58窗口仅用于先前准备，不能复用于新部署、扩权或G4。下一轮UTC起止须重新确认；最多90分钟的参考窗口包含清理余量，不自动延长。窗口到期停止新写；若清理未完成，记BLOCKED并申请有效恢复窗口，保留CONTROL epoch/历史关联，不把租约/帧到期当作已关闭服务端白名单。关闭工具Invoke授权/并发也要留审计和可恢复步骤，不删历史审计来伪装干净。

## 6. 本批交付、检查和缺项

本批交付机器计划、8份IAM/信任/调用/控制面增量策略模板、版本比较、封闭操作/验签参考及本地测试、源/产物摘要。只在本地读Git/文件、运行PGlite和合成签名测试，未调用AWS账号接口；公开AWS文档用于核对政策语义。

本地参考/策略检查52项、现有执行包回归136项通过；另行检查了格式、Node语法、MJS lint、边界、证据和敏感信息。IAM草稿静态检查不是AWS IAM模拟或目标AccessDenied测试。

必要的目标handler、ledger实际事务、Lambda/IaC接线、IAM service evaluation、实际Key读取、PG/DDB目标写竞争、版本proof v2接收规则及新目标观察均NOT_IMPLEMENTED/NOT_RUN。缺少实际device/customer ID、工具版本、批准的新政策/窗口等，模板保持未解析，不自填真实值。当前准入仍11/22、G4 NOT_RUN。

初次本地对照夹具把wire日期字符串传给要求Date的实际signer，保留原FAIL；仅修正夹具类型后通过。初次Git路径比较因非ASCII路径被引用而拒绝等价，保留原FAIL，改用NUL分隔读取，没有放宽分类或源Hash条件。新增控制面草稿时曾生成无效的Invoke策略结构，原FAIL保留；修正生成器参数并加入全部IAM草稿结构断言后通过，未提交AWS。另有一次本地语法检查命令的重定向位置错误，修正命令后四文件语法检查通过；该调用错误说明也保留。未解决本地FAIL及全部检查结果见[result.json](../audit/evidence/2026-11-08-device-image-minimal-closure/result.json)。

下一可执行任务为MC01：实现闭合Writer/ledger与单run Verifier真实代码，并补齐本地事务、未知结果和授权失效测试；随后MC02本地IaC/权限审查。部署、IAM变更及新G4窗口分别审批，本方案和此前W01～W07授权均不代替这些授权。
