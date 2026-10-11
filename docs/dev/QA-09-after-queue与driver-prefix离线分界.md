# QA-09 after-queue 与 driver-prefix 离线分界

本任务建立可重复的离线分界，不接入目标运行时、不增加开关、不部署。已有候选默认关闭及数据库预算保持原状。上轮目标应用 SHA 为 `5773ac9d7bad13d41c2d00e456f8b633fa939579`，其 R0/R1 已完成清理与关闭恢复；[目标回执](../audit/QA-09-5773ac9安全分类与未知启动R0-R1目标复验-2026-10-11.md)只是本次问题输入。

## 分区与稳定接缝

新增夹具使用真实 Prisma client/query extension、公开 PrismaPg/transaction queryRaw 接口、仓库自有观测导出及既有 pg 租约；仅 pg 网络被受控替身接管。每个独立进程使用一个 pool(max=1)，先准备客户端和执行原账号读取，再按原事务完成 load/update/readback/audit；审计返回投影 ID_ONLY_OFFLINE 明确区别于目标完整投影。

| 父窗口 | 离线分区 | 起止边界 | 可解释范围 |
| --- | --- | --- | --- |
| after-queue | checkpoint-phase-setup | 共享 checkpoint 捕获→after-queue phase 创建返回 | 自有 phase 初始化及测试标记开销 |
| after-queue | checkpoint-output-return | phase 创建返回→原 await-queue 结束输出返回 | 既有检查点日志/回调输出 |
| after-queue | engine-dispatch-gap | 检查点结束回调返回→共享 DRIVER_DISPATCH | 引擎推进、调度与调用间隔的合并区间，未隔离 compiler |
| driver-prefix | repository-driver-setup | DRIVER_DISPATCH→自有公开桥接函数进入 | 自有 phase 关闭/初始化、原日志输出 |
| driver-prefix | observer-public-bridge | 桥接进入→原 work 回调进入 | 桥接及离线包装器开销 |
| driver-prefix | adapter-entry-wrapper | work 回调进入→受控公开 adapter 包装端口进入 | 公开调用包装的入口间隔，非 Prisma 内部入口 |

所有时钟使用单调微秒及上下界 bracket；每组分区下界之和加边界不确定区间，严格等于 enclosing bracket。CPU 增量来自测试端口附近的 process.cpuUsage，范围为进程所有线程，可能超过墙钟；不能视为单分区独占 CPU。V8 Inspector 只在显式离线 profile 组启动，采样间隔1000µs，保留±100µs边缘模糊样本和全部未解析位置。位置计数不是 CPU 时间；WASM/OTHER_UNRESOLVED 不能升级成 compiler 因果证据。

输出记录仅分配给唯一完全包容的分区，跨边界为 AMBIGUOUS，父窗口外为 OUTSIDE。不产生按 CPU 或输出扣除后的优化收益。共享 DRIVER_DISPATCH 的 bracket 会分别出现在两个父组的守恒式，两个父组不能因此把不确定区间重复相加。

## 有界矩阵

固定16个子进程、串行、每个≤45秒。成功场景每进程首个及两个后续事务，失败场景一个事务，共36次事务；每样本最多一次20ms受控 CPU，6类控制共18次。单 profile≤45000样本/8MiB，观测区间≤64。零额外查询、零强制让步、零网络连接、零云端/部署动作。原业务路径已有的观测 queueMicrotask 保留；不使用旧窗口夹具的两次强制 Promise.resolve 让步。

场景包含 default-off、reference、boundary-on、profile-on，检查点 CPU/输出、pre-driver CPU、driver setup CPU、prefix输出、public bridge CPU，以及 pre-driver/public/pg/validation/update/audit 六类拒绝。成功与预期失败必须满足一次 load、预期 update/readback/audit、BEGIN/COMMIT/ROLLBACK、checkout/release/disconnect 数量；公开桥接和 adapter 包装器逐次断言原 Promise 身份。早期拒绝只保留部分标记，不生成完整分区；更新或审计失败保留已完成 load 分区，但事务仍回滚，不宣称业务成功。

```sh
export PATH=/Users/anray/.nvm/versions/node/v24.12.0/bin:$PATH
node scripts/run-qa09-contract-dispatch-offline.mjs /tmp/qa09-dispatch-unique-directory
node --test scripts/qa09-contract-dispatch-proof.test.mjs
pnpm exec vitest run packages/database/test/contract-dispatch-offline.test.ts
```

必须使用不存在的目录，失败或已完成目录均不得复用。runner只继承 PATH/HOME/TMPDIR/LANG/TZ/NO_COLOR；不继承 AWS、数据库凭据和候选环境参数。运行前后核对源文件、锁文件、实际安装 Prisma runtime/adapter/生成 Client/编译器文件及部署默认配置哈希；当前 SHA 的云端数据不会被读取或写入。

## Gate 与目标接线决定

本轮离线边界和事务/Promise 所有权 Gate 可闭合，目标新分界 Gate 为 NOT_RUN，readyToDeploy=false。原应用/配置/Admin hook/工作流/精确采集器均不改。没有可证明的优化收益或 P95。

下一阶段可设计目标化自有 checkpoint 结束和 driver 准备边界，复用默认关闭候选的一次有界摘要，先补缺边界、重复回调、同步抛错、异步拒绝、输出失败/重入、限额及租约所有权矩阵。目标只能标记自有调用端边界；离线 adapter 包装端口不能自动宣称真实 adapter 内部入口。Inspector、受控 CPU、vi.mock、pg 替身和测试端口包装器不得进入生产依赖。目标 schema、默认关闭开关/配置/Admin/部署/精确采集器及新 SHA 对照闭合前，不派发部署或 R0/R1。
