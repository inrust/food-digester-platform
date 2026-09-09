# BE-OTA-03 OTA MQTT 下发与状态接收

## P1 安全与并发闭环

| 控制 | 当前实现 | 本地验收证据 |
| --- | --- | --- |
| Target-bound 下载 | Dispatcher 为每个 target 创建 32 字节随机一次性 token，仅保存 SHA-256；MQTT 只携带 Device mTLS API grant URL。兑换端同时校验可信证书映射的 deviceId、targetId、packageId、Campaign/Target/Package 状态、15 分钟 expiry、unused/revoked，再原子消费并返回剩余 TTL 内的 S3 地址 | 跨设备 403、重复消费 409；数据库无明文 token；Device API 307 禁止缓存 |
| 条件 claim + lease | `ota_targets` 保存 `dispatchClaimedAt/dispatchLeaseUntil/dispatchLeaseToken/dispatchAttemptCount`；仅 PENDING 且无有效 lease 可领取，发布前重读权威状态；暂停/取消清除 lease 并撤销未消费 grant，过期 lease 可恢复 | 两个并发 dispatcher 仅 1 次 MQTT；claim 后暂停产生 0 次 MQTT；崩溃 lease 过期后可恢复 |
| 原子副作用 | MQTT 成功后仅 lease owner 可在单一事务写 PENDING→NOTIFIED、状态历史、OTA_AVAILABLE Outbox、DEC-016 PUBLICATION Outbox 与审计 | 人工制造 publication 幂等键冲突时，target/history/notification 全部回滚 |
| Outbox 幂等 | 两条 Outbox 使用 `ota-target:{targetId}:dispatch:{attemptNo}:{available|publication}` 唯一键；合法设备失败重试使用新的 dispatch attempt | 同一 attempt 不可重复写，新的业务重试不与旧 publication 冲突 |

生产接线：`GET /api/v1/device/ota/targets/{targetId}/download` 进入独立 Device mTLS Lambda；Device API 获得 OTA Bucket 只读权限，OTA Dispatcher 不再读取 OTA Bucket，只持有数据库和 OTA Topic 发布权限。默认 execute-api URL 会保留 stage path；配置自定义 mTLS 域名时使用该域名。

边界：上述为本地实现、PGlite 并发/事务测试和 CDK synth 证据，不等于目标 AWS 中的 mTLS、IoT、S3、竞态及过期行为回执。
