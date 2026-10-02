# QA-09 当前测试环境真实身份与只读数据库通道

使用账号`065986019555`、`ap-southeast-1`、`fdp-test-app`。2026-10-02用户授权补齐AWS内只读查询通道、准备本轮专用测试身份并执行业务验收；明确不修改已有管理员密码。无需本机直连RDS或新建环境。

## AWS内查询通道

`fdp-test-qa09-readonly-runner`是本轮专用CodeBuild项目，复用当前Migration Runner的VPC、子网、数据库安全组、服务角色和日志组。没有修改原`fdp-test-migration-runner`或CloudFormation应用Stack；专用项目由本任务脚本管理，不属于原Stack，保留供QA-09后续查询使用。没有创建新IAM角色、网络或数据库。

固定`NO_SOURCE` buildspec携带探针字节、SHA256、源码基线和Migration/Schema清单。启动只传项目名，不接受SQL、buildspec、角色、源码或环境变量override。Node24容器安装锁定`pg@8.23.0`，使用RDS CA严格验证TLS。Secret仅在AWS容器内存解码，不进入日志、回执或本机；探针核对账号、Runner角色、BuildId、DB Secret ARN、主机/库名与探针Hash。

事务固定`REPEATABLE READ READ ONLY`，语句超时10秒、锁超时2秒，finally始终ROLLBACK。只执行迁移校验、固定表计数、角色/Scope聚合、Onboarding列存在性及旧记录缺CSR计数；可选清理前缀只接受`qa09-`加16位十六进制，绑定参数核对Customer/Site可见记录与业务用户数量。没有动态SQL入口。项目最长5分钟、排队最长5分钟、并发1、自动重试0。

该通道复用现有数据库主账号权限，**只读由固定探针与数据库事务强制执行，不是独立SELECT-only数据库账户**。不要将项目或服务角色开放为通用执行入口。后续改动须重新检查固定源码/Hash与查询范围。元数据查询成功和Build SUCCEEDED不代表Migration或业务Gate通过。

```sh
node scripts/prepare-qa09-db-readonly-probe.mjs /tmp/qa09-db-preparation.json [本轮清理前缀]
# 从preparation.project提取创建/更新请求；只操作fdp-test-qa09-readonly-runner。
# 初次创建使用aws codebuild create-project，后续固定探针更新使用update-project。
# 均使用esgiot-infra，核对现有VPC/SG/角色与生成请求一致，不修改Migration Runner。
aws codebuild start-build --project-name fdp-test-qa09-readonly-runner --profile esgiot-infra --region ap-southeast-1
node scripts/collect-qa09-db-readonly.mjs /tmp/qa09-db-preparation.json <BuildId> <回执.json>
```

采集器使用`esgiot-readonly`检查Build成功、服务角色/VPC定位、唯一日志JSON帧、源码/探针Hash、只读事务及迁移比较，分别输出queryGate、migrationGate和schemaGate。CodeBuild日志保留期沿用现有日志组；本轮探针准备包和JSON回执另归档到`docs/audit/evidence`，含固定探针源码的base64字节，不含Secret值。

## 真实身份与业务Smoke

AWS SSO用于AWS操作；五角色业务登录通过真实Cognito与管理后台现有SRP实现完成，客户端不增加USER_PASSWORD_AUTH。执行器使用AWS SDK读取`esgiot-infra`正常SSO凭据，临时密码、新密码及Token只驻留内存；不传密码进shell参数，不发送邀请邮件（SUPPRESS），不保存凭据。

```sh
node --import tsx scripts/run-qa09-real-business-smoke.mjs <业务回执.json>
node scripts/check-qa09-real-business-smoke.mjs <业务回执.json> <执行源码归档.json>
node --test scripts/qa09-*.test.mjs
```

每次随机运行前缀；先创建专用SuperAdmin，再经真实API创建两个Customer，准备Operator/Auditor及绑定Customer A的CustomerAdmin/Viewer，创建两个Site。覆盖五角色NEW_PASSWORD_REQUIRED→新密码→SRP认证、刷新、错误密码、同Customer读取、跨Customer拒绝、只读角色写拒绝、用户列表权限、Customer更新及过期If-Match 409。无route interception、HAR或本地服务替身。五身份是Cognito业务认证夹具，未替代管理API邀请/激活/角色对账的完整验收。

每创建一个身份/记录立即保存创建账本。finally逆序通过API软删除本轮Site/Customer，核验GET404；对本轮精确用户名GlobalSignOut、AdminDeleteUser及AdminGetUser不存在核验。已有用户、设备、队列消息和历史Onboarding不作为清理目标。业务软删除保留数据库行和审计，不能宣称物理删除或数据库恢复为全空。

Gate仅认证五角色与Customer/Site Smoke子范围，要求完成时间、全部必需探针、创建账本、清理及执行源码字节Hash；`fullQa09Accepted=false`。初次CLI标准输入失败保留诊断回执；已归档的SDK实跑源码与当前脚本分别版本绑定，当前脚本改为清理结束后才输出终态PASS，归档版本的终态回执同样要求finishedAt及清理证明。

## 完整QA-09的边界

缺少Migration时不启动Migration Runner，不伪造CSR填补旧记录，也不删除历史数据。第三次只读查询确认两条旧Request均APPROVED，关联Job均COMPLETED，关联现存Onboarded设备；当前旧Onboarding记录的CSR列不存在且有2条记录，自动应用移除Token迁移会在NOT NULL前置条件失败。后续需要先只读定位关联、制定历史记录保留/处置方案，再绑定批准源码、工件Hash/S3 VersionId执行Migration。设备CSR/mTLS/证书生命周期、10设备IoT链路、全部业务领域、真实浏览器、安全/负载及八项原目标Gate继续逐项验收。

具体历史白名单、备份和版本工件范围见[待确认方案](../audit/QA-09-CSR迁移与历史数据处置待确认方案-2026-10-02.md)。本轮身份是可重复创建/清理的夹具，清理后Group恢复没有专用成员是正常状态，不代表本轮真实登录未执行。
