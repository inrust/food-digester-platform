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

## IMG-09 实施补充（2026-11-06）

[IMG-09 迁移与验收](./IMG-09-图片触发引用迁移与本地验收.md)已将上述模型落实为 Prisma 和事务式向前 SQL，并在隔离 PGlite 中验证。目标库未连接或迁移。

实施增加 Evidence 的 Customer/device/kind/messageId 不可变快照及复合 FK，使来源与媒体的双向归属一致性由数据库维护；原父表主键不变。绑定会话、触发申报和证据不可删除重建，绑定媒体只保留状态软删除路径，历史无关联记录保持原行为。新增非空 triggerId 的单 ISSUED 部分唯一索引，因此后续替换过期会话必须先显式置 EXPIRED。原有空 triggerId 不参与该唯一键，也不补猜精确字节或来源。

IMG-10～13 的会话业务、同事务登记、解析和查询仍按原分工执行。PGlite、契约和本地打包结果不替代真实数据副本、原生多会话锁、S3 与目标验收。

## IMG-10 实施补充（2026-11-06）

[IMG-10 会话业务与验收](./IMG-10-触发图片上传会话与本地验收.md)已实现严格 triggerRef、不可变申报、200 重用、201 过期新办和两类 409。锁顺序是设备、Trigger 的 FOR NO KEY UPDATE、会话；Trigger 锁兼容登记端 KEY SHARE。实际登记事实采用 MediaObject 判断，与来源是否 LINKED 分开。

新创建的会话保存已知精确字节，包括旧格式请求；历史 NULL 不回填。重签只使用存储的原到期时间、长度和 Hash，签名失败后重试不重复占额度。本批没有部署、迁移目标库或接入 IMG-11 同事务登记，后续仍须补齐登记消费者后才可启用完整触发链路。


## IMG-11 实施补充（2026-11-06）

[IMG-11 登记事务与验收](./IMG-11-图片登记事务与本地验收.md)已将生产登记拆分为事务外 S3 预检与事务内设备→Trigger→会话持锁提交；与 IMG-10 共用设备和 Trigger 锁。图片、PENDING Evidence、会话完成、receipt、唯一 Outbox 与审计/缺口处理共同提交或回滚。非空 sizeBytes 严格比较精确字节，历史 NULL 保留 KB 兼容；Hash 使用实际流式计算值。

Outbox 类型为 MEDIA_EVIDENCE_REGISTERED，唯一键为 media-evidence:<triggerId>，不混入 ARCHIVE。本地已验证原有租约发送器可持久化重试；正式解析路由及消费者留给 IMG-12。重复消息不重置 Evidence 时间，旧会话被替换后不能登记；旧版绑定媒体若已完成但缺 Evidence/Outbox 则失败关闭，需上线前盘点，不自动补造 24 小时窗口。G2 继续 PARTIAL，未部署或迁移目标库。


## IMG-12 实施补充（2026-11-06）

[IMG-12 解析与验收](./IMG-12-图片关联解析与本地验收.md)已实现登记提交后首试、MEDIA_EVIDENCE_REGISTERED 持久化消费路由及独立分钟任务。Evidence 持锁后按原租户/设备和 sourceMessageId 精确匹配；告警已清除仍匹配原 ACTIVE，清除消息引用、明确范围不符或固定 24 小时到期转 UNMATCHED，终态不重开。

扫描按 (nextAttemptAt,id) keyset 有界分页，默认 50×5 行，PENDING 下次时间不超过原 deadlineAt。新向前迁移只补 ARCHIVE/alarm/CLEARED 原消息查询的部分表达式索引及模型摘要，不修改历史行。独立 Lambda、分钟规则、重试/DLQ、权限及连接预算已通过离线检查；规则沿用 enableScheduledWorkers，目标开关未更改。G2 仍为 PARTIAL，IMG-13 和目标环境/真机证据待补，本批未部署或迁移目标库。


## IMG-13 实施补充（2026-11-07）

[IMG-13 查询与验收](./IMG-13-图片证据查询与本地验收.md)已实现告警详情和事件列表 evidenceImage：源读取权限与 media:read 同时满足才查询关联；无媒体权限省略字段，有权限但无 LINKED 返回 null，有关联返回原媒体的 mediaId/captureTime/AVAILABLE 或 DELETED。下载继续独立鉴权，DELETED 拒绝签名。

图片按原来源与媒体的 Customer、设备和 sourceMessageId 校验，不按当前设备分配迁移历史归属。事件列表只批量加载当前页，告警清除后保留原 ACTIVE 对应图片；未新增迁移、wire 字段或权限点。本地两类触发已通过模拟存储/入库/JWT 查询链路，G2 仍为 PARTIAL，真实目标证据未补，本批不部署、不迁移目标库。


## IMG-14 实施补充（2026-11-07）

[IMG-14 页面接入与验收](./IMG-14-平台图片预览与本地验收.md)已在设备查看/操作页共用实时图片组件，按独立 viewer、30 秒租约、10 秒续租和 2 秒读图接入管理端三个接口。关闭、切换和页签隐藏会取消请求、清图并尽力释放；恢复可见申请新 viewer。基本帧/租约截止与迟到隔离已提供，完整异常恢复留给 IMG-15。

归档入口继续手动刷新，未增加上传会话或消耗归档配额，未启用任何目标设备能力。CT-06 锚点及前端 Base64 脱敏镜像已同步。仅本地模拟浏览器和源码检查通过，G3 为 PARTIAL；未部署、不迁移目标库，真实身份、存储和设备证据仍需后续验收。
