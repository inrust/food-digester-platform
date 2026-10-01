# QA-09 AWS 隔离环境只读预检

本轮执行任务清单 QA-09 的第1步。产物是可复跑的只读采集器、环境准备清单及实时资源回执，不是整套 AWS 验收结果。只读预检完成后，Readiness 仍为 BLOCKED；目标业务验收为 NOT RUN / NO RECEIPT。

## 运行与保护

```sh
pnpm qa:aws-preflight /tmp/qa09-readonly-preflight.json
node --test scripts/qa09-readonly-preflight.test.mjs
```

采集器固定 `esgiot-readonly` / `065986019555` / `ap-southeast-1` / `fdp-test-app`。首先核对 STS 的精确账号与 FDP-ReadOnlyOps 角色，再核对 Stack ARN、Region、`fdp:env=test` 和项目标签。校验未通过时，不继续查询业务资源。队列 URL 和 Bucket 输出另校验测试前缀/账号。预检未接入普通 `pnpm verify`，避免开发机或 CI 隐式读取 AWS。

所有 AWS 调用均为 describe/list/get 元数据读取，最多4路并发，每次45秒超时，禁用自动多次重试。Cognito 只保留状态、启用标记和各 Group 的成员数量，不保存邮箱、用户名、sub 或凭据；Lambda 不读取环境变量；CodeBuild 只投影构建状态、对象版本及精确源码 SHA；CloudFormation Template 仅保留 Lambda Code 资产定位。

不调用 Secrets Manager GetSecretValue、SQS ReceiveMessage/PurgeQueue、IoT Publish、Lambda Invoke、CodeBuild StartBuild、身份/资源创建或修改。公开端点仅 GET/OPTIONS，TLS 不关闭证书校验，无 Authorization/Cookie，丢弃正文，只保存状态码、CORS 和请求 ID。无客户端证书时的 ECONNRESET 仅记录传输拒绝，不能替代带合法/非法证书的完整 mTLS 正负验收。

依赖本机 AWS CLI 和已登录的 ReadOnlyOps SSO。GitHub CLI 的404可能是私有仓库可见性/认证问题，记录 UNVERIFIED，不能推断仓库或工作流不存在。采集器不会登录、切换身份、推送或触发构建。

## 采集范围与事实边界

- Stack 输出与资源状态；项目 Lambda State、更新状态、CodeSha256 和 Template Code 资产。
- RDS 可用性、私有/加密、备份与 Multi-AZ；不访问数据库凭据或执行 SQL。
- Cognito Pool/Client、五角色 Group 与成员状态；CONFIRMED/Enabled 只证明成员状态，不能证明测试者持有登录凭据或业务 Scope 正确。
- IoT ATS Endpoint、Thing 数及证书总数/ACTIVE 数；不读取设备私钥，也不把账号总数量当成 QA09 夹具所有权证明。
- 五队列近似深度/重驱配置，存储版本化状态，API 域名与 mTLS truststore 对象版本。
- Migration / Bootstrap Runner 最近5次构建元数据，Amplify 最近5次 Job，GitHub main及测试部署 Run 的只读可见性。
- 已有月预算的限额/用量/过滤范围；该预算不等于本轮测试写入授权或自动停费硬限额。
- 八个既有目标证据 Gate 的实际退出码；不写入占位 PASS。

采集器比对最近成功 Migration Runner 的提交树和当前40份迁移 SQL。差异只证明历史构建来源缺少/改变了文件，不能证明数据库尚未通过其他方式应用；当前 `_prisma_migrations`、关键表、双 Customer 和10设备状态均须另取得只读证明。

每份预检回执绑定 Git 基线、采集器/测试、配置、package.json和全部迁移 SQL Hash。`phase=READ_ONLY_PREFLIGHT`、`execution.mode=REAL_AWS_READ_ONLY` 与业务 AWS PASS 回执区分。元数据观察即便全部正常，采集器仍保持业务验收 NOT RUN；未检查的写入、清理、身份控制和恢复授权不会自动变为 READY。

## 环境准备与下一阶段

详细事实和缺口见 [本轮报告](../audit/QA-09-只读预检与环境准备-2026-10-01.md)，可填写的具体授权范围见 [授权模板](../audit/templates/qa-09-isolated-acceptance-authorization.template.json)。该模板为 NOT_APPROVED，仅描述后续准备动作，不会执行。

按顺序解除阻碍：恢复仓库只读部署证据可见性；取得当前数据库只读 Migration/计数证明；审查3个新迁移是否需要按精确工件升级；由已有管理员邀请缺失三角色并关联两个隔离 Customer；准备10套可控设备身份和证书；确认成本、制品保存及前缀限定的写入/清理范围；补齐未覆盖领域的真实目标执行器/回执/Gate；最后再开展集中实跑。

已有管理员系统非空，不能再次运行“首个平台管理员 Bootstrap”。隔离队列中的既有消息不得作为新夹具清理目标。RDS 当前备份与恢复能力须在任何故障注入批准前另行核对，不根据本轮预检自动修改备份或注入故障。
