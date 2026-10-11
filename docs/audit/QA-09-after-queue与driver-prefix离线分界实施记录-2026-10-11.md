# QA-09 after-queue 与 driver-prefix 离线分界实施记录

已建立预算内离线分界；默认关闭候选及生产运行时未修改。本轮 Gate 为 OFFLINE_BOUNDARY_PASS，目标新分界 NOT_RUN，QA-09 总体/P95 仍 PARTIAL。[复验说明](../dev/QA-09-after-queue与driver-prefix离线分界.md)、[证据目录](evidence/qa-09-dispatch-offline-2026-10-11/)。

## 变更

新增 `packages/database/test/contract-dispatch-offline.test.ts`、`helpers/contract-dispatch-probe.ts`，以真实 Prisma 与受控 pg 建立7个自有/公开端口标记，分为3个 after-queue 和3个 driver-prefix 不相交下界区间。公开 bridge 与 adapter wrapper 保留原 Promise 对象；无额外 await/查询，不强制造冷。新增 scripts 的 runner、证明器/类型声明/反篡改测试，固定16独立进程并绑定运行前后源哈希；新增本报告、开发说明及离线封存证据。应用、生产 packages/src、infra、部署工作流、Admin配置及采集器均未修改。

上轮真实目标 after-queue 462–464ms 和约56ms driver-prefix 仅作为历史输入；本轮没有 AWS 读写或新目标回执。[历史目标证据](evidence/qa-09-5773ac9-r0-r1-2026-10-11/r1/contract-window-observations.json)通过哈希绑定，历史716份封存保留原状。

## 离线结果

最终矩阵 `matrix-final/matrix.json`：16个独立进程、36个事务样本 PASS；6种CPU/输出控制均位于预期分区，6种失败符合预期回滚及查询/租约次数，缺失的分区不被补成成功。default-off/reference 均无新增标记或控制。单pool(max=1)、网络0、额外查询0、强制让步0；每个进程≤45秒，每个控制样本20ms。

最终 profile-on 首样本的 after-queue 三段下界为36µs、16µs、15378µs，driver-prefix 为130µs、19µs、19µs。engine-dispatch-gap 的15400µs量级区间观察10个确定内侧 V8位置采样，其中9个 OTHER_UNRESOLVED、1个 PRISMA_RUNTIME_LOCATION；该区间进程CPU增量29484µs，高于墙钟，直接说明不能当作单线程或 compiler 独占时间。六个20ms正向控制均被定位，但本机 Darwin/arm64 的约15ms间隔不能解释 AWS 的约463ms；离线约0.17ms prefix 也不能解释目标约56ms。

本轮没有证明 compiler 内部稳定入口或优化收益。driver-prefix 在自有设置/日志、公开桥接、测试 adapter 入口之间已经具备可验证分界；目标化仍需单独实现默认关闭的一次有界摘要及配置/采集闭环。Inspector与受控CPU仅留在 test 依赖。

## 检查命令与结果

| 命令 | 结果 |
| --- | --- |
| `node scripts/run-qa09-contract-dispatch-offline.mjs …/matrix-final` | 16进程、36事务 PASS，输入哈希无漂移 |
| `node --test scripts/qa09-contract-dispatch-proof.test.mjs` | 19项 PASS |
| `pnpm exec vitest run`（9个相关运行时/所有权文件，见证据日志） | 100项 PASS |
| `pnpm test:scripts` | 初次沙箱1034/1037，3项本机listen EPERM；放行回环端口后同一套件1037项 PASS，原失败日志保留 |
| `pnpm typecheck` | 21个工作区任务 PASS |
| `pnpm exec eslint . --ignore-pattern 'build/**'` | PASS，仅排除原有未跟踪build |
| 新增6个源文件 `prettier --check`、边界/敏感信息检查 | PASS |

没有因这次离线新增夹具重跑完整22步应用发布链或浏览器目标验收；相应 Gate 不迁移为新 SHA 目标 PASS。仓库原有未跟踪 build/ 与可访问性报告/证据未修改。初轮矩阵 PASS 保留在 matrix/；复核时将 adapter 入口前移至测试输出测量前，并收紧区间 kind/唯一公开调用校验；中间2条断言的拒绝码更新及最终重跑记录在 review-refinement.json，初轮不作为当前源版本验收。

## 风险与下一任务

本轮新目标分界 NOT_RUN，compiler CPU/优化收益/P95/网络节点归因均未闭合；设备 HMAC、自然 Active、邀请发送仍沿用原 NOT_RUN。所有候选默认关闭，数据库静态预算63≤70来自上轮目标回执，本轮没有云端预算调整或峰值证明。

下一可执行任务：接入默认关闭的自有 checkpoint结束/driver准备边界与一次有界摘要，补完整失败/重入/限额/租约所有权矩阵及配置/Admin/部署/精确采集器闭环；人工推送后再讨论新 SHA 的匹配自然冷对照。
