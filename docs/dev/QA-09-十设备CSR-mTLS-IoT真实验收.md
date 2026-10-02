# QA-09 十设备 CSR / mTLS / IoT 真实验收

目标为现有测试账号065986019555、ap-southeast-1、fdp-test-app；当前成功后端部署、CI与Amplify提交均为`00ec272f1c5ae73a8b4a990cd744f4b992fd67f3`。执行器工作区源码按字节SHA256另行绑定，不能把本地新执行器提交等同于已部署应用版本。

## 版本前置与命令

```sh
node scripts/collect-qa09-application-version.mjs docs/audit/evidence/qa-09-application-version-2026-10-02.json
node --import tsx scripts/run-qa09-ten-device-acceptance.mjs docs/audit/evidence/qa-09-ten-device-2026-10-02.json docs/audit/evidence/qa-09-application-version-2026-10-02.json
node scripts/check-qa09-ten-device-acceptance.mjs docs/audit/evidence/qa-09-ten-device-2026-10-02.json docs/audit/evidence/qa-09-ten-device-gate-2026-10-02.json
node --import tsx --test scripts/qa09-ten-device*.test.mjs
```

使用Node24.12和仓库已安装依赖。本机AWS SSO使用esgiot-infra管理本轮夹具、esgiot-readonly核验部署与Build。版本采集器只读检查准确提交的CI、GitHub OIDC/CDK部署、Amplify，并读取CloudFormation指定的S3 ZIP字节，与当前各Lambda CodeSha256比较并检查健康状态。默认完整版本检查要求工件字节通过。可先用 `--runtime-only` 生成独立运行版本回执：准确提交的部署、CI、Amplify及所有Lambda健康状态通过后，允许执行业务测试；工件字节仍须在最终子Gate前补齐，不能将运行版本回执的PARTIAL当作完整字节PASS。不自行启动部署。SSO临时AWS凭据仅经本机CLI加载到SDK内存，业务密码/Token及设备私钥不落文件。

## 实际覆盖

随机`qa09-`加16位十六进制前缀，创建本轮专用SuperAdmin并通过真实SRP/NEW_PASSWORD_REQUIRED登录，创建两个Customer，按5/5准备10台库存设备。当前无库存创建API，因此固定CodeBuild项目`fdp-test-qa09-ten-device-fixtures`仅用于本轮seed、READ ONLY observe和精确ID cleanup；复用现有VPC/角色，不更新原Migration Runner或只读项目，不开放调用方SQL。事务核验Customer ID/名称、十设备ID/序列号/所属Customer，原设备和证书规范JSON摘要必须一致，否则ROLLBACK。

每台RSA-2048独立CSR私钥仅驻留进程内存；通过真实匿名申请、管理员审批和CSR私钥签名轮询取得仅含公钥的证书包，确认CSR公钥与返回证书匹配。首台附加同钥幂等、换钥冲突、Nonce重放和错误私钥拒绝。轮询间隔3.5秒，遵守当前30次/分钟IP限制，等待真实定时Provisioning Worker；不得绕过业务入口直接注册测试证书来宣称CSR通过。

10个真实MQTT mTLS会话使用返回endpoint和deviceId Client ID同时连接，各发送Heartbeat；AWS内只读查询核验Onboarded、ACTIVE、包销毁、MQTT验证时间。逐台真实REST mTLS Sync核对自身设备，验证缺失证书和不受信任证书拒绝。每台发送两条Telemetry并重发第一条完全相同原文，间隔10秒；复核30条唯一IngestionReceipt、每设备业务sampleCount=2、20条Telemetry ARCHIVE Outbox PUBLISHED。实际尝试跨设备Subscribe/Publish，要求Broker明确拒绝/关闭且无PUBACK，不能用本地authorize函数的抛错替代AWS权限验收。

S3按两Customer精确前缀读取gzip归档，只保存Key、压缩字节SHA256、原文SHA256、消息/事件ID和计数。核对已发布Payload规范化Hash、IngestionReceipt、Outbox原文Hash及归档原文Hash；原文、证书、私钥、密码、Token和签名URL不落回执。

## 清理与边界

创建ID即时记账，finally关闭MQTT，AWS内精确发现本轮10设备证书，停用、解除自身Thing/Policy附着并删除；移除自身Thing，再事务删除精确设备关联的本轮Request/Nonce/Job、状态/收据/聚合/Outbox/证书/设备。PROCESSING Job拒绝删除；非本轮名称或关联立即停止。保留原设备/证书摘要，未知FK或并发漂移失败关闭，不TRUNCATE，不消费、清空或改动历史队列。S3仅删除本轮两Customer前缀发现的精确Key及其版本，复核不存在；Customer通过API软删除并GET404，专用Cognito身份登出、删除并核验不存在。审计和软删除Customer行按业务规则保留。

专用项目创建需要 esgiot-infra 对现有执行角色的限定 `iam:PassRole`；当前AWS拒绝该权限，尚未创建项目和设备库存。最小权限待确认方案见 [权限方案](../audit/QA-09-十设备夹具项目最小权限待确认方案-2026-10-02.md)。已有项目更新保留原serviceRole，先核验角色一致；不自动提升IAM权限。临时夹具项目在全部回执归档后清理。加密RDS历史快照继续保留。本轮只证明10设备CSR、mTLS及Heartbeat/Telemetry归档子范围；剩余6类上行、Command/OTA/Media全业务、完整前端、安全与负载，以及原IoT Gate的errorAction/partialFailure等探针仍需后续执行，不填造`environment.isolated=true`或故障注入PASS。完整QA09始终由全部适用目标回执共同决定，当前子Gate的`fullQa09Accepted=false`。
