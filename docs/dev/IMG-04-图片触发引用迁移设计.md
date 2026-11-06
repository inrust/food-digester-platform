# IMG-04 图片触发引用迁移设计

P0 提供以下迁移设计，实际 Prisma 和 SQL 迁移属于 IMG-09。采用可空外键和新增表，旧记录无需推断来源。

## 表与约束

| 对象 | 新增设计 |
|---|---|
| MediaTrigger | UUID id、customerId、deviceId、kind EVENT/ALARM、messageId、mediaType 固定 IMAGE、fileName、sizeBytes、sizeKb、sha256Normalized、createdAt。UNIQUE(customerId,deviceId,kind,messageId)，申报字段创建后不可修改 |
| MediaUploadSession | nullable triggerId FK MediaTrigger，保留每次签发记录。精确 sizeBytes 加 nullable 列，旧记录无值继续按旧策略；新记录填入。triggerId 索引，当前有效会话在锁定 MediaTrigger 后选择，避免多个并发签发 |
| MediaEvidence | triggerId UNIQUE FK、mediaId UNIQUE FK、status PENDING/LINKED/UNMATCHED、alarmId 或 eventId nullable FK、registeredAt、deadlineAt、nextAttemptAt、attemptCount、failureReason、updatedAt。PENDING 到终态条件更新 |

MediaTrigger 的唯一约束保护不可变申报。锁定触发记录后再按既有设备行锁顺序领取配额。先锁设备，再创建或锁触发记录，再锁会话，所有消费者采用同一顺序，减少死锁。已存在触发且申报不同返回 MEDIA_TRIGGER_CONFLICT。已登记返回 MEDIA_ALREADY_REGISTERED 及 mediaId。有效会话返回 200，不重复领取配额。过期会话新办返回 201 并计新配额，旧 key 永不复用。

文件 Hash 统一为小写 hex 后比较，fileName 原样，sizeKb 等于 ceil(sizeBytes/1024)。MediaEvidence 完成 MediaObject 注册后与 receipt、会话状态、Outbox 同事务写入。晚到旧会话在截止后拒绝；跨会话竞争通过 trigger 唯一登记和事务锁保持最多一张图，未登记对象按自有 key 清理。并发的原对象注册若已成功，新会话申请必须返回已登记状态。

## 关联和历史兼容

ALARM 引用 ACTIVE 原消息 ID，与 Alarm.sourceMessageId 精确匹配，告警清除后保留关联。EVENT 与 DeviceEvent.sourceMessageId 匹配。关联同时核验同 deviceId 和原 customerId，设备后续改客户不能把旧照片移给新客户。引用不存在先 PENDING，登记后最多 24 小时；按每分钟分批重试。明确归属不符、已知 CLEARED 引用或超时转 UNMATCHED，并记录安全的失败原因。

LINKED 约束要求 kind=ALARM 时仅 alarmId 非空，kind=EVENT 时仅 eventId 非空；PENDING/UNMATCHED 两者均空。重复 worker 使用预期 status 的条件更新，事务失败重试，FK 保证目标存在。不能按 code 或最近时间猜测。PENDING 索引按 status、nextAttemptAt、id；UNMATCHED 保留运营排查能力。文件删除只改变媒体状态，不级联删除来源或关联。

原 Alarm、DeviceEvent、MediaUploadSession 和 MediaObject 保持原主键。旧会话 triggerId=null，旧媒体继续查询与下载，旧请求不返回 triggerRef。告警及事件查询无 media:read 时省略 evidenceImage，有权限但无 LINKED 记录时返回 null，有关联时返回 AVAILABLE 或 DELETED。下载仍经既有独立授权入口。

## 迁移和回退次序

1. IMG-09 在空库及历史数据副本添加表、可空列、外键和索引，验证旧数据查询及旧接口样例。只回填可确定的精确字节值，其余保留 null。
2. 先部署能读取新结构且兼容旧请求的服务，再开启 triggerRef 写入，最后上线关联查询和页面。
3. 回退关闭新能力，保留新表和关系供后续恢复，旧请求继续运行。共享源记录删除遵循外键限制，清理器先核对关联与归档保留期。
4. 本批未执行数据库迁移。迁移锁时长、回填规模、真实并发和对象清理证据在 IMG-09 至 IMG-13 验证。
