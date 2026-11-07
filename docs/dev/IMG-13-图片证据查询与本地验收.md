# IMG-13 图片证据查询与本地验收

2026-11-07，基于本地提交 `be3f4b74` 实施。初始 main 工作区干净，已有九个未推送提交。本批仅本地开发与验证，不部署、不连接或迁移目标库、不推送。

依据：[接口设计](../api/device-image-interface-design.md)、[开发计划](../api/device-image-development-plan.md)、[IMG-04 迁移设计](./IMG-04-图片触发引用迁移设计.md)及 [IMG-12 验收](./IMG-12-图片关联解析与本地验收.md)。完成告警详情和事件查询的 evidenceImage 及读取权限；平台预览、图片入口和设备 App 仍属 IMG-14～18。

## 修改文件

| 文件 | 内容 |
|---|---|
| `apps/cloud-api/src/admin/alarm/evidence-query.ts` | 统一图片投影、源记录/媒体权限交集、精确原始范围与类型验证、按页批量查询 |
| `apps/cloud-api/src/admin/alarm/service.ts` | getAlarm/listDeviceEvents 接入 evidenceImage；服务入口重验 alarm:read；详情查询将客户范围下推数据库；DTO 使用既有生成 EvidenceImage 类型 |
| `apps/cloud-api/test/evidence-image-query.test.ts` | 34 项图片查询、状态、权限、租户、分页、错误隔离及两种触发的本地入口链路测试 |
| `apps/cloud-api/test/admin-alarm.test.ts` | 原必填字段断言增加契约已有的可选字段及 null 断言，保留完整 OpenAPI 校验 |
| 本文、开发计划和 IMG-04 补充 | 本批状态、验证、FAIL 历史、NOT_RUN 和下一步 |

没有新增 API、数据库模型/迁移、权限点或云资源。P0 已冻结 Alarm/DeviceEvent 的可选 evidenceImage，本批直接复用 `contracts/rest/image-types.ts` 中的 EvidenceImage；无需重新生成类型、修改冻结基线或升级 wire 版本。现有路由和组合根自动进入更新后的 Service。

## 返回与权限

适用接口：`GET /api/v1/admin/alarms/{alarmId}` 和 `GET /api/v1/admin/events` 中的每条记录。

| 条件 | 返回 |
|---|---|
| 未认证 | 原有 401，不查询图片 |
| 无 alarm:read | 403，媒体权限不能代替源记录权限；直接 Service 调用同样拒绝 |
| 有源读取权限、无 media:read | 保留原源记录响应，完全省略 evidenceImage；不查询 Evidence/媒体，不泄露 mediaId |
| 双权限、无 LINKED 图片 | evidenceImage=null，包括未上传、PENDING、UNMATCHED 和无 sourceMessageId 的历史来源 |
| 双权限且关联媒体 AVAILABLE | `{mediaId,captureTime,status:"AVAILABLE"}` |
| 双权限且关联媒体 DELETED | 保留同一 mediaId/captureTime，status="DELETED"；独立下载接口返回 404，不调用签名器 |
| 跨 Customer 的告警详情 | 404，不查询或泄露图片，保留源记录存在性保护 |
| 客户查询事件 | 继续强制 actor.customerId 范围；请求参数不能扩大到外租户 |
| 依赖查询失败 | 使用现有安全错误响应，不伪装为没有关联图片 |

示例：

```json
{
  "evidenceImage": {
    "mediaId": "<registered media ID>",
    "captureTime": "2026-11-06T09:00:00.000Z",
    "status": "AVAILABLE"
  }
}
```

查询不生成下载 URL。只有 mediaId、媒体原拍摄时间和可用状态进入新增字段，不包含对象路径、文件申报、Hash、触发 ID、原消息 ID、Base64 或签名 URL。拍摄时间取 MediaObject.captureTime，不用告警/事件发生时间替代。

既有 `GET /api/v1/admin/media/{mediaId}/download-url` 继续独立验证 media:read、原媒体 Customer 和当前可用状态。元数据查询需要源记录和媒体双权限；没有改写媒体库原本的独立下载权限规则。页面后续凭 mediaId 另取短期 URL。查询和后续下载分别以各自读取点的状态授权，不承诺撤回已经签出的 URL。

当前五个正式角色都已有 alarm:read 和 media:read，行为不变更权限矩阵。省略字段及权限交集分支通过受控权限撤销测试验证，未新增虚构角色或扩大权限。跨租户另使用真实本地 RS256 JWT/JWKS 验证器测试。

## 数据与查询边界

详情先验证 alarm:read，将 Customer actor 的范围放入来源查询条件；来源不存在或越界时不会读取 Evidence。事件列表保留原有筛选、id ASC 游标和 limit+1 规则，先切出当前页，再批量查询本页图片，lookahead 行不进入图片查询。

每次批量查找只接受 kind 对应、status=LINKED 的 Evidence，并要求源 ID、原 Customer、设备和 sourceMessageId 全部吻合。选取媒体的最小必要字段后，独立重验媒体 ID、原 Customer、设备、IMAGE 类型及 AVAILABLE/DELETED 状态。即使数据代理返回异常投影，也不能把外范围媒体放进响应。

事件页仅调用一次批量 Evidence 查询，关联媒体由 Prisma 批量投影；没有按每行调用查图或下载服务。空页、无媒体权限及全是历史无消息 ID 的页不调用 Evidence 查询。不引入新缓存，后续请求能观察删除或权限变化；查询本身不修改关联状态、尝试次数或时间。

使用原始资源归属，不按设备当前 Customer 重新划分历史照片。设备后来换客户，旧客户仍可查看自己的原来源及图片；新客户不能读取旧记录或获得其 mediaId。告警确认/清除后，原 ACTIVE 消息的 LINKED 图片不丢失；相同 code 的多个告警或相同 eventType 的事件各自使用自己的关联。

本批只扩展告警详情与事件列表。告警列表、确认/清除响应和 Tamper 查询保留各自原有返回范围，不额外加载图片。

## 本地检查

使用全部 migration 后的隔离 PGlite、真实 Prisma、会话签发/媒体登记/关联解析和管理 Handler。图片使用已有 JPEG，本地 Map 模拟对象存储，签名器不访问 S3；JWT 使用进程内随机 RS256 密钥和 LocalJWKS，不访问 Cognito。

| 检查 | 结果 |
|---|---|
| 图片查询专项 | PASS，34 项 |
| 新专项及原告警/媒体测试 | PASS，3 文件、56 项；最终夹具区分来源时间与拍摄时间后复验通过 |
| cloud-api/database/aws-clients/ingestion-worker/summary-worker/infra 回归 | PASS，155 文件、1413 项，maxWorkers=4 |
| contracts 全套 | PASS，319 项；可选字段、旧请求及冻结基线保持兼容 |
| OpenAPI | PASS，bundle 新鲜度和 Redocly |
| runtime/migration/CDK 脚本测试 | PASS，17 项 |
| cloud-api 及依赖、ingestion-worker/summary-worker、infra 类型和构建 | PASS |
| 迁移漂移 | PASS，本批无新迁移 |
| 运行交付清单 | PASS，134 operations |
| 当前产物离线 CDK synth | PASS，无 warning，真实资产及原有接线检查通过，未部署 |
| 包边界、sensitive sinks、secrets | PASS |
| 修改 TS 的 ESLint/Prettier、git diff --check | PASS |

覆盖 AVAILABLE/DELETED、无上传/PENDING/UNMATCHED/历史来源、无身份、缺源权限、缺媒体权限、五角色及复合角色、跨租户、设备转租户、告警确认/清除后读取、同 code/类型分离、批量分页与 lookahead 排除、状态/权限更新后读取、异常投影及安全 500。

两类触发分别经本地正常入口执行：源消息 schema/身份校验及入库 → mTLS 会话 Handler → 本地对象上传替身 → Media ingestion receipt/登记/立即关联 → 重复投递 → 原管理 Lambda 路由和 JWT 查询 → 外租户 JWT 拒绝泄露图片。它是本地模拟存储的后端链路，不是 AWS IoT/S3 或真机验收。

### 中间 FAIL 与修复

保留中间失败，不以最终 PASS 覆盖执行历史：

- 首轮原模块回归 21 PASS/1 FAIL：旧测试把响应字段等同于 required 列表，未计 P0 已批准的可选 evidenceImage。按既有契约增加字段和 null 断言，并校验完整响应，没有修改 wire schema。
- 新专项首次连同原回归为 24 PASS/32 FAIL：夹具将登记时间冻结在执行主机当天的未来，违反既有 `updatedAt>=registeredAt` 约束；改为固定过去时间，不放松数据库约束。另一个 typecheck FAIL 来自测试中有意返回损坏投影的 async 替身不具备 PrismaPromise 品牌；明确限定为测试适配器，生产类型没有削弱。
- 第二轮专项 54 PASS/2 FAIL：JWT 组合根夹具只提供 Alarm 路由组，而原路由器会提前读取完整 operation map。补齐其余组的拒绝执行替身，保留 Alarm/Event 的真实服务及 JWT；未改变生产路由器。第三轮及最终专项均为 56 PASS。

最终未解决 FAIL=0、BLOCKED=0。预期权限拒绝、数据库异常和删除拒绝下载仍保留断言。

### NOT_RUN

- 真实 PostgreSQL 多连接下的删除/查询/权限变更竞争及生产规模分页性能；PGlite 结果不能替代这些证据。
- 真实 Cognito 用户/角色撤销传播、公开 API Gateway/JWT/mTLS、真实设备与浏览器。
- 真实 S3 PUT/GET、签名 URL 下载、对象过期删除与数据库 DELETED 同步；本地没有发送云请求。
- 目标数据库连接或迁移、云资源部署、Git 推送、真实历史数据副本、全仓 verify/页面 E2E、正式目标 Gate。
- IMG-14～18 的平台预览、留档图片入口与设备 App，以及后续目标环境/真机验收。

G2 仍为 PARTIAL：IMG-09～13 的本地归档后端已完成，并有两类触发的本地模拟链路；真实存储、消息、身份及目标运行证据待补。拍照白名单、设备规模和首帧等待目标仍 OPEN。

下一可执行任务是 IMG-14：在平台设备页增加预览入口、查看租约和画面状态，接入已有五个预览接口；进入后续租读图，关闭或切换设备取消在途请求并释放租约，后台页签停止续租。IMG-16 后续复用本批 evidenceImage 与现有独立下载接口展示留档图片。

## 复现命令

本机使用 `/opt/homebrew/bin/pnpm` 10.20.0，Node 24.22.1。以下 pnpm 指该绝对路径。

```sh
pnpm exec vitest run apps/cloud-api/test/evidence-image-query.test.ts apps/cloud-api/test/admin-alarm.test.ts apps/cloud-api/test/media.test.ts --maxWorkers=4
pnpm exec vitest run apps/cloud-api/test packages/database/test packages/aws-clients/test apps/ingestion-worker/test apps/summary-worker/test infra/test --maxWorkers=4
pnpm --filter @fdp/cloud-api... typecheck
pnpm --filter @fdp/ingestion-worker typecheck
pnpm --filter @fdp/summary-worker typecheck
pnpm --filter @fdp/infra typecheck
pnpm --filter @fdp/cloud-api... build
pnpm --filter @fdp/ingestion-worker build
pnpm --filter @fdp/summary-worker build
pnpm --filter @fdp/infra build
pnpm test:contracts
pnpm openapi:check
node --import tsx --test scripts/check-delivered-runtime.test.mjs scripts/check-migrations.test.mjs scripts/check-cdk-synth.test.mjs
node scripts/check-migrations.mjs
node scripts/check-boundaries.mjs
node scripts/check-sensitive-sinks.mjs
node scripts/check-secrets.mjs
node --import tsx scripts/check-delivered-runtime.mjs
PATH=/opt/homebrew/bin:$PATH AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=ap-southeast-1 node scripts/check-cdk-synth.mjs
```

对四个修改/新增 TS 文件运行定向 ESLint/Prettier，另执行 git diff --check。未执行 deploy、目标 prisma migrate 或 push。
