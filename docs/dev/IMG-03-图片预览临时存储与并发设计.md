# IMG-03 图片预览临时存储与并发设计

## 选型和边界

选择单区域 DynamoDB 作为后续实现的共享临时存储。帧、查看租约和幂等摘要以逻辑过期时间判定。P0 不创建云资源。本地验证执行版本号条件提交的参考模型，验证抽象协议的交错结果。AWS 请求表达式、事务取消、吞吐和故障恢复须在后续适配器及目标环境验证。

DynamoDB 原生支持条件写及多项事务，适用于 Lambda 多实例共享帧。与已有 PostgreSQL 存图相比，可减少大图片对业务库的读写压力。Redis 也可用 Lua 原子执行，但需要增加集群和连接管理。DynamoDB 的大帧事务读写成本、单设备热点和 5 秒空闲查询量需在 IMG-23 按规模测算。事务内不能对同一 item 同时执行 Update 和 ConditionCheck，应把条件放到该 Update。 [AWS 事务 API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)

## 数据结构

主键 PK 为 DEVICE 加原始设备 ID，SK 区分下列项。所有读写来自同一区域的主表，预览读取使用事务快照，不依赖 GSI 或最终一致读。授权隔离同时依赖当前台账与记录内 Customer 和 authEpoch。 [AWS 事务与隔离](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

| SK | 字段与用途 |
|---|---|
| CONTROL | revision、authEpoch、customerId、enabled、streamId、viewers、latestCapturedAt、lastNewFrameAt。viewers 为 actorId/viewerId 到 expiresAt 的映射，上限 16，复合键编码须无歧义 |
| FRAME | streamId、authEpoch、customerId、frameId、capturedAt、receivedAt、expiresAt、mimeType、imageBase64、ttl。每设备一张 |
| DEDUP 加 streamId 和 frameId | requestHash、receivedAt、expiresAt、dedupUntil、ttl。摘要 15 秒逻辑有效，结果沿用原时间 |

CONTROL 的 revision 单调递增，不能因 TTL 删除重建而回绕。保留 CONTROL 元数据，流切换时清除采集时间水位并分配随机 UUID streamId。lastNewFrameAt 作为设备级限频时间跨流和授权代次保留，由 IMG-06 落实。FRAME 和 DEDUP 可用 TTL 回收，读取和条件写始终显式判断逻辑截止。每帧标准 Base64 至多 174764 字符，180 KiB 请求限制与字段开销由契约测试核验，适配器另验序列化项目大小。

## 原子边界

1. 创建或续租先读 CONTROL，移除逻辑过期查看者。通过 revision 和 authEpoch 条件替换 CONTROL，无有效查看者到有查看者时创建新 streamId。达到 16 仅拒绝新查看者。释放按 actorId/viewerId 删除，只能释放自身。CAS 失败后重新读、重新鉴权并计算，不能复用旧 activeUntil。
2. 帧上传在验证准入、JPEG 和当前时间后，读取 CONTROL 与去重摘要。同 ID 同 Hash 在有效摘要窗口内返回原结果且不写帧，异内容冲突。新帧事务对 CONTROL 做条件更新，并 Put FRAME 与 DEDUP。条件包含 revision、authEpoch、customerId、streamId、至少一份未到期租约、采集时间大于水位、距上次新帧至少 1000ms。最后租约释放会修改同一个 CONTROL，陈旧上传必然失败并重新判定。
3. latest 用 TransactGetItems 读取 CONTROL 与 FRAME。当前用户自己的租约、授权代次、streamId、帧截止均有效才返回图。旧帧被物理保留也不可见。最后租约失效后重开分配新 streamId。
4. 数据库与 DynamoDB 之间不具备单事务边界。后续实现必须让预览请求和取消分配、挂起、退役及授权变更操作，参加同一设备 PostgreSQL 锁协议。预览在事务内持有设备共享行锁，核对当前身份与台账，并保持锁直到 DDB 操作或快照读取结束。变更方先取排他行锁，封闭或递增 DDB authEpoch、清租约，再提交数据库变更。身份验证到拿锁之间也须在锁内复核。数据库失败而 DDB 已封闭时保持拒绝，恢复须再次检查数据库并使用新 epoch，不能倒退。
5. 用户角色撤销及白名单变更需锁内重验当前授权版本，并执行同样封闭顺序。无法读取权威授权状态则拒绝操作。在撤销前已经完成快照读取的请求可完成响应，撤销后获取锁的新请求必须失败。已到浏览器的图片由本地截止定时器清理。不得承诺撤回已发送响应。

该锁协议需要后续修改相关生命周期及授权写入入口，这是 IMG-05 至 IMG-08 的实施依赖。只在请求开始查一次数据库再更新 DDB，不能通过授权撤销验收。短事务锁时长与外部存储调用超时必须有界，限流和存储失败后释放锁，响应 503。先读缓存再异步撤权的做法不满足此设计。

## 本地验证和后续事项

运行 `node --import tsx --test contracts/domain/live-image-concurrency.test.ts`。模型显式暴露读取快照与条件提交，遍历最后释放和上传的六种合法交错，检查多查看者、旧帧覆盖、授权 epoch 失效、租户变更和逻辑过期。CAS 失败必须重读后重试，终态与重新启用不能接受旧流请求。

模型通过只说明原子假设下状态机成立。真实 DynamoDB 条件表达式、跨 PostgreSQL 写入口锁覆盖、JWT 权限撤销传播、多实例延迟、TTL 回收及容量成本均为 NOT_RUN。P1 必须先给存储适配器补等价测试，再经公开入口取得目标证据。

## IMG-08 实施补充（2026-11-06）

[IMG-08 实现与验收](./IMG-08-共享存储运行入口与本地验收.md)已将逻辑模型接到真实 SDK：永久 CONTROL 与带 TTL 的 FRAME/DEDUP 分为两表，继续使用跨表事务，后台任务仅获得 CONTROL 失效权限。服务端白名单落为 PostgreSQL 缺省关闭的逐设备表。

P0 实现使用全局共享/排他 advisory 屏障加设备/用户行锁，将所有部署的 Prisma 写入组合根纳入协议；DDB 封闭按受影响设备或含该主体的流执行，未知 SQL/关系写保守扩大范围。SQL 回滚保留关闭，提交后重验和恢复必须核对原关闭版本，后续失效不可被较早事务覆盖。外部 I/O 同时受事务生命周期和租约/帧截止约束。

已补 SDK 命令、PGlite 事务、路由串联和 IaC 本地验证。原生多会话锁、真实 DynamoDB 隔离、TTL、容量和公开域名仍 NOT_RUN；本节不回写或替代原 P0 参考模型证据。
