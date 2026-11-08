# IMG-21 隔离模拟设备、安全身份及执行窗口准备

2026-11-08。基于干净 main `0f4fc6ac` 继续；应用候选仍为 d1a7b811，G3证据提交1b1b879f，云端接口协议摘要不变。用户允许先完成可独立工作，云端写入/设备启用必须列范围后确认；不推送。App与真机不作为前置。

**本地准备完成；13项真实准入输入仍BLOCKED，G4=NOT_RUN。** 本轮执行AWS只读元数据查询，没有创建目标客户/设备/用户、签发证书、启用预览、启动CodeBuild、连接目标库、部署或迁移。材料位于[本次目录](../audit/evidence/2026-11-08-device-image-fixture-preparation/)。

## 已完成的独立工作

- 核实只读身份属于065986019555的FDP-ReadOnlyOps，Stack fdp-test-app为test且UPDATE_COMPLETE。20个Lambda当前CodeSha256与历史已验证制品一致，20个RevisionId也未变；19个数据库权威入口的CONTROL/PAYLOAD配置可核验。CONTROL未开TTL，PAYLOAD按ttl清扫。这里只证明当前读取的代码/配置，不能把历史69c76e1d的部署SHA写成d1a7b811。
- 核实CustomerViewer组、Cognito客户端与两个既有CodeBuild项目元数据；未读取已有用户凭据、私钥、Token或Secret值，也未借用历史设备/用户。
- 生成独占序列号 `img21-22d71f6bcb59dee6` 的RSA3072私钥和PKCS#10 CSR，验证CSR签名及公钥摘要。私钥仅在仓库外/private/tmp的700目录内，文件600；仓库只保存公共CSR、摘要和安全引用。该路径不是持久保险库，实际执行前须重新验证存在性与权限，丢失则重建计划，不能悄悄复用旧申请序列号。
- 准备1客户、1站点、1软件设备、1张证书、1份短期License、1个CustomerViewer及1个临时PlatformSuperAdmin审批身份的名称/上限。目标ID仍为null，计划名称和安全引用不冒充真实ID/可用身份。临时超级管理员只用于本轮审批/配置，准备后立即停用；不修改V1角色矩阵。
- 7个HTTP写请求已按冻结OpenAPI做Schema检查，审批/签发无请求体时为null；使用真实公共CSR和计划名称，响应ID保留变量，executable=false。测试License仅拟议ESG_REPORTING、2026-11-08至11-09；执行日期变化须重新确认，不回填旧日期，不运行ESG/OTA/远控。
- 为剩余13项逐项补充材料来源、7份证明草稿、序号预算、清理方案和窗口提案。所有proof仍passed=false，不自签授权或目标通过；不把本地密钥引用当作已签发mTLS身份。

## 真实缺项及发现的前提

| 输入组 | 当前准备 / 尚缺内容 |
|---|---|
| deployedCommit、deploymentProof、runtimeVersionsProof | 20个函数的当前Hash/配置已读；候选与历史1693份交付源无差异的审查来自上轮封存证据。仍缺精确候选部署证明或经核验的源等价绑定决策，以及真实执行窗口内复核；不伪造d1部署，不自动发起部署 |
| migrationProof | 当前44项源清单/SQL摘要已准备；目标原生迁移状态尚未重新查询。启动只读作业本身是CodeBuild控制面写入，仍待确认 |
| deviceId、customerId | 唯一名称和CSR已准备；须经批准后真实创建，记录API返回ID和归属基线 |
| deviceMtlsRef、mqttIdentityRef、viewerARef | 安全引用/本地CSR已准备；须经批准后签发/登记证书、建立Cognito与数据库用户/客户scope，验证可用后才填入 |
| testScopeProof、cleanupPlan | 已列单客户/单设备及明确写入上限、恢复/保留规则；待用户确认与实际ID/执行入口绑定 |
| executionWindowProof | 提议批准且前置核验完成后起90分钟准备窗口；起止UTC、批准引用未填，未擅自排定。后续G4窗口45分钟另行记录 |
| sequenceReservation | 新设备拟议1～128，尚未真实保留；须记录首次Heartbeat前的基线和独占状态，重启不重置 |

代码检查发现以下前提，不能靠假数据绕过：

1. 预览要求lifecycle与operational均为Active/Maintenance；CSR接入首次Heartbeat只完成Onboarded，仍需分配及正常License Sync RECEIVED/VERIFIED流程。必要的专用测试License验签入口需先绑定授权；不导出HMAC key，不裸SQL改Active，不把它转成等待实体设备/App的要求。
2. PlatformOperator没有onboarding:approve，因此拟议临时审批身份为PlatformSuperAdmin；默认只读查看身份仍为CustomerViewer。现有run-admin-bootstrap只适用于空用户系统，**不能在本环境运行首次管理员bootstrap**。专用创建用户/scope及白名单的受控执行入口、源码摘要和既有IAM权限仍须绑定；没有这些条件就保持BLOCKED，不自动扩权或部署新入口。
3. 服务端白名单没有公开HTTP写接口；启闭必须用createPreviewAwarePrismaClient按单deviceId处理，保留授权epoch失效协议，不直接改DDB。
4. 现有数据库只读作业默认buildspec与当前仓库不一致（原始两份Hash及install阶段差异保留为BLOCKED）。已准备[固定单次StartBuild请求](../audit/evidence/2026-11-08-device-image-fixture-preparation/readonly-db-start.request.json)：只覆盖本轮固定buildspec及44项manifest/探针Hash，不更新项目、角色、VPC，不部署/迁移。其请求Hash在write-approval-request中绑定；未经确认不执行。

## 待确认的云端写范围

精确范围见[写操作申请](../audit/evidence/2026-11-08-device-image-fixture-preparation/write-approval-request.json)及[窗口提案](../audit/evidence/2026-11-08-device-image-fixture-preparation/window-proposal.json)。这些文件approved=false、executionEnabled=false。

| 编号 | 请求范围 |
|---|---|
| W01～W02 | 在既有User Pool最多创建两个本轮身份：CustomerViewer和临时PlatformSuperAdmin，SUPPRESS通知；仅为这两人建立数据库既有V1角色/scope。随机密码仅存仓库外私密区，不发送邀请、不改现有身份；禁止使用首次管理员bootstrap |
| W03 | 正常业务API创建1客户/1站点，提交本轮CSR、审批、由现有Worker发1证书并登记IoT，首Heartbeat与分配；仅处理本轮API返回ID |
| W04 | 创建并签发1份短期测试License，正常Sync RECEIVED/VERIFIED；只在已授权的现有专用测试验签入口中验签，不修改生命周期字段 |
| W05 | 仅对本轮序列号对应deviceId启用本地opt-in和1条服务端白名单，受控client写入并验证准入；不批量启用，不触碰其他设备 |
| W06 | 最多启动既有fdp-test-qa09-readonly-runner一次，使用申请文件绑定Hash的单次buildspec/manifest覆盖；数据库只读。不能因“DB只读”而忽略StartBuild仍需确认 |
| W07 | 停用本轮临时身份、关闭预览、释放本轮租约、撤本轮证书/测试License；保留CONTROL epoch、历史关联、receipt和审计。若无安全物理删除流程，保留关闭的客户/站点/设备台账，不用裸SQL删除 |

本申请不含真实CF01～CF03业务写入、App/真机测试、共享故障、IAM扩权、新云基础设施、部署、数据库迁移或Git推送。后续G4可用受控模拟客户端，三项图片接口闭环即可判定，不等扩展44项/24小时/容量测试。

## 检查与证据边界

- 本地包约束13项测试通过；涵盖错误账号/角色/非test栈、只读收集器拒绝写入/Invoke/读取Secret、计划ID不冒充真实ID、窗口不自签、私钥权限、禁止裸SQL/首次bootstrap、单次固定作业请求与清理边界。
- 7个HTTP请求Schema检查通过，公共CSR经OpenSSL验签；离线准备器可重复生成相同内容。目标执行包136项回归及包Hash/源校验通过，应用候选与协议摘要不变。
- 初次Schema辅助命令因未安装ajv-formats失败（ERR_MODULE_NOT_FOUND），FAIL明细保留；改用仓库现有createAjv完成检查，未新增依赖。未解决本地FAIL=0。
- 默认只读作业源漂移BLOCKED、13项目标输入BLOCKED均保留。批准记录、精确窗口、当前候选目标部署/原生数据库新证明、身份签发/可用性、License确认、白名单启用、真实传图/G4和清理均NOT_RUN；不能用只读元数据或CSR准备替代。
- 本批未重跑全量verify/全仓脚本/构建：未修改业务、契约、IaC或独立协议工具；仅新增本批审计收集器/材料及进度记录，已运行适用定向检查。G3仍使用既有d1候选完整证据，非本提交全量复验。

下一步先取得精确写入范围及90分钟准备窗口确认。执行前复核范围、源摘要、身份和私钥；受控执行入口/权限或候选版本证明未满足时停止，不把确认当作绕过技术门禁的许可。G4的45分钟实际窗口待设备与身份就绪后单独确认并写入UTC起止。
