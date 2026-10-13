# QA-09 自有导出租约与自然日报、归档、ESG 一致性复验

本手册承接 QA09-CLOSE-07，同步产出 CLOSE-08 的正式回执映射。仅使用现有 AWS 测试环境和已授权权限；不调整 IAM/KMS、连接池、并发或共享队列，不恢复性能 R0/R1。

## 入口与范围

先确认同 SHA CI/测试部署成功、19 个实际工件一致、API 配置仍为 pool=1/512MB/保留并发12，候选默认关闭。记录实际 SSO 登录至少10分钟、infra角色至少75分钟清理余量。只读容量探针使用全新 Plan，读事务、零业务写；原 FAIL/UNKNOWN 与禁止重启约束保留。启动前失败不能写成未知 StartBuild 已成功。

本轮执行器冻结27份依赖字节后运行。新前缀10设备、2客户、SUPPRESS专用管理员通过真实 CSR/mTLS/MQTT；设备保持非 Active，不造 VERIFIED。20条 Telemetry 加2条 Report（每客户1台设备），Report 原始数据、UTC周期和哈希均记账；每条 Report 仅在已确认原 PUBACK 后投递一次相同内容，任何首次发布结果未知均不重发。

## 执行

使用已安装 Node 和依赖。以下环境变量必须绑定已成功发布的完整 SHA 与 Deploy run ID，版本文件必须包含19工件 PASS；每次使用全新输出路径。

```sh
QA09_EXPECTED_COMMIT=<完整SHA> QA09_DEPLOY_RUN_ID=<运行ID> \
node --import tsx scripts/run-qa09-esg-closeout-target.mjs \
  <新证据目录>/target.json <新证据目录>/application-version.json
```

执行器最多75分钟等待既有 Summary 自然调度，通过有界 GET 读取两客户的日报/ESG结果；不手动调用共享 Summary，不向 RDS 播种日报/ESG读模型。受控只读 Worker 精确核对32条 receipt、20样本、每设备 UTC 小时/日桶的13指标 avg/min/max/count、两条 Report 和两条 ESG 日摘要、计算版本及22条 ARCHIVE outbox。

MQTT 发布字节与 Ingress Envelope 原文属于不同摘要范围：前者只在发布账本中保存摘要，后者含五个 `iot*` 上下文字段。只读快照通过设备/Topic/规范化 Payload 摘要绑定 Outbox；归档核验再检查完整 Ingress 字节摘要、五个上下文字段及剥离这些字段后的完整 Payload 摘要，不能把两类原文字节直接比较，也不能只比较 `meta`。

Report 使用模拟设备的合法上报值；这里只证明处理和汇总一致性，不证明真实传感器算法或第三方碳核证。归档读取器逐条复算原文及规范化 Payload 哈希，核对 GZIP 摘要、Manifest 的 key/count/eventIds/customer/topic。`manifestProjectionSha256` 是解析后对象的序列化摘要，不称为原始 Manifest 文件字节摘要。

通过实际 API 创建 HOURLY、DAILY、REPORTS、DAILY_SUMMARY 四个精确设备/客户导出，要求非空 CSV 与同一只读数据库快照逐字段相等。只对本轮已知 COMPLETED 导出，以精确 Job/客户/设备/requestedBy 白名单注入过期 PROCESSING 租约；等待自然 Worker 恢复，并确认租约清空、完成时间更新、CSV字节不变。身份、下载 URL、Token 和私钥只在内存，不写证据。

## 失败与清理

任何未知业务 POST、SQL写 Build 或首次 MQTT PUBACK 结果保持未知，阻断破坏性清理，先定位原操作；不重启原 Plan、不盲重试。已知拒绝只记账，不重发。若唯一不确定项是冻结源码的只读审计，且自有写入已终态成功、无未决POST，则原只读FAIL/UNKNOWN仍保留，允许继续已授权的精确资源清理，不宣称该审计成功。清理先删精确导出对象全部版本，再做自有业务表清理/范围外摘要核验，最后由父流程清理设备、证书、客户和身份。Report原文前缀纳入父清理，未发布Report的旧执行路径保持原范围。

```sh
node --import tsx scripts/collect-qa09-reliability-final.mjs \
  <新证据目录>/target.json <新证据目录>/final-readonly.json
node --import tsx scripts/qa09-formal-closeout-map.mjs \
  <新证据目录>/target.json <新证据目录>/final-readonly.json \
  <新证据目录>/application-version.json <新证据目录>/formal-map.json
```

最终独立只读核验数据库/身份、8个自有原文前缀和4个导出对象的版本/删除标记均空，并核对每个已知 Build 终态；最后再读19工件及默认配置。正式映射执行8个原 Gate、列出原必需集合和未覆盖范围，不造 `isolated=true`，不把候选证据写成完整正式 PASS。原失败与未知启动永久保留。

## 离线验证

```sh
node --import tsx --test scripts/qa09-esg-closeout.test.mjs scripts/qa09-formal-closeout-map.test.mjs
node --import tsx --test scripts/*.test.mjs
```

专项测试使用实际处理器、全部 PostgreSQL 迁移、Summary/Archive/Export 服务，包含跨客户、缺桶、计数/指标/原文/Manifest漂移、错误租约所有者、恢复时间/CSV漂移、有界等待和CSV语法失败。离线 PASS 不替代目标环境回执；CLOSE-07、CLOSE-08及整体 QA-09 分别报告，未覆盖设备验证、可信固件、Replay唯一生产关联、其他角色及通知边界仍是缺口。
