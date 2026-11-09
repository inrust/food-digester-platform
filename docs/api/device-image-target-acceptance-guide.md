# IMG-21 云端目标验收执行包（准备阶段）

MC03 的[独立 V2 版本接收协议](../../tools/image-acceptance/README.md)绑定冻结候选和工具清单；本指南原有命令仍默认 strict。仅在独立审阅明确批准后才选 V2 源等价，历史部署 SHA 不改写。本地证据不能作为目标通过。

2026-11-08，按用户确认的六项范围组织。当前重新验证的候选为 `d1a7b81196d60ec320e760da3d18de403563fc12`，接口契约 `0.16.0`、DEC-009@2.0.0。**本轮只重新验证本地G3与重绑定，G4仍为NOT_RUN。** 工具不调用真实云端接口、不部署、不连接或迁移目标库、不启用目标设备。此前69c76e1d的目标检查及迁移见[历史准入推进报告](../audit/图片G3重新绑定与G4准入推进-2026-11-08.md)；其输入、CI/部署和观察保留原候选，不能直接改名为本轮d1a7b811的结果。App与真机由第三方负责。

## 当前 G4 口径：云端图片接口闭环

按本轮用户确认，**G4=云端图片接口验收，不依赖第三方 App 或真机通过**。用受控模拟设备发真实请求即可；G3 仍绑定 d1a7b811 和证据提交 1b1b879f。只有真实云端响应、业务确认和读回图片一致时才能判定目标通过，离线校验上限仍是 PASS_STRUCTURE_ONLY。

| 核心用例 | 通过条件 |
|---|---|
| CF01 实时预览 | 平台申请租约、设备读取 ACTIVE/current streamId、POST JPEG/Base64 返回200、latest READY；解码后 JPEG 字节数与 SHA-256 一致；释放204 |
| CF02 EVENT 留档 | 原事件 meta.id → triggerRef → 上传会话 → S3 原 JPEG → MQTT media 登记；同申报409 MEDIA_ALREADY_REGISTERED确认业务登记，事件查询 AVAILABLE，同一 mediaId 下载字节一致 |
| CF03 ALARM 留档 | 同 CF02，但 triggerRef 引用 ACTIVE 原告警 meta.id，告警详情 AVAILABLE；不得用 CLEARED ID、PUBACK 或仅 S3 2xx 代替业务完成 |

三项均 PASS，来源/版本/身份/时间窗可核验且本轮资源清理记录完整，即可在真实 G4 报告判定 PASS_CLOUD_INTERFACES。**不要求 App 安装包、相机、第三方测试报告、真机、SLA、原生故障注入或24小时观察先通过**。这些是独立后续验收/扩展回归，不计本次接口 Gate 的前置；其 FAIL/BLOCKED/NOT_RUN 原样保留。若发现图片链路本身失败、越权或数据泄漏，仍属于本接口 Gate 的失败，不能用缩小范围掩盖。

原 44 项用例和 35 项输入保留为扩展回归套件，其完成与否不阻塞三项核心接口 Gate。下文中 AR12 五个可达变体、原生/24h/容量的“必测”和完整性检查均针对该扩展套件；V1 权限矩阵及唯一源码 N/A 规则不变。未执行扩展用例保持 NOT_RUN，不标免测或 PASS。

新的云端核心入口（均只读本地文件/Git、绝不调用目标）：

```bash
node scripts/device-image-target-package.mjs --cloud-templates
node scripts/device-image-target-package.mjs --cloud-admission <run-dir>/inputs.json
node scripts/device-image-target-package.mjs --cloud-receipt <run-dir>/receipt.json <run-dir>/inputs.json
```

云端核心使用 profile=G4_CLOUD_INTERFACE_V1、22项输入、3项用例。proof、输入、receipt及证据均绑定同一候选/protocolDigest/runId；实时图读回、S3 Hash、triggerRef、业务登记和 AVAILABLE 关联都需精确匹配，不接收仅写 passed=true 的回执。`--cloud-templates` 是模板输出；模板不能算真实执行。`--cloud-admission` 检查执行窗口的 SCHEDULED/OPEN/EXPIRED 状态，过期阻塞；版本/迁移/运行证明须有本轮窗口内观察时间。窗口尚未确定时不自行填写批准日期。离线工具不签发真实执行授权，也不会给 G4 PASS。

当前确认沿用 fdp-test-app（ap-southeast-1），设备和身份待准备；对应[准入工作包](../audit/evidence/2026-11-08-device-image-cloud-interface-readiness/inputs.json)、[版本审查](../audit/evidence/2026-11-08-device-image-cloud-interface-readiness/versions.review.json)及[执行安排](../audit/evidence/2026-11-08-device-image-cloud-interface-readiness/schedule.json)。9项环境定位从历史材料提取并按用户确认沿用，13项执行输入待补齐。历史证明不改 SHA、不伪造新观察，不自动部署或重复迁移。模拟客户端凭据仍必须对应独占隔离测试设备，不能借用现场设备身份。

## 1. 候选和 G3 证据绑定

[包目录](./fixtures/device-image-target)包含 12 个生成文件；[组包与校验器](../../scripts/device-image-target-package.mjs)只使用本地文件和 `git cat-file`，没有 HTTP/AWS/数据库客户端、凭据读取或远程执行开关。

| 文件 | 内容 |
|---|---|
| `candidate.json` | 候选 SHA、G3 result/源清单/证据清单的路径与 SHA-256、冻结摄像头参数、六项范围 |
| `manifest.json` | 每个导出文件和组包脚本、测试、用例、SQL、指南及冻结输入的 SHA-256，不自哈希 |
| `inputs.template.json` | 35 个目标输入、提供方角色、类型；全部 value=null，不能被当作已具备环境 |
| `cases.json` | 44 个有依赖顺序的目标用例、断言 ID、证据种类、必要变体，全部 NOT_RUN |
| `receipt.template.json` | 44个目标用例仍NOT_RUN；AR12单一源码不可达变体单列NOT_APPLICABLE及sourceExclusions，G4=NOT_RUN |
| `resources.template.json` | runId 资源台账、原状态摘要和清理复核字段；初始空白 |
| `reachability.json` | AR12受源码约束的单一N/A决策、源码摘要和独立本地回归依据；不是通用豁免开关 |
| `openapi.json` | 五个预览接口及归档申请/告警详情/事件查询/媒体下载的独立 OpenAPI；服务器刻意使用 `.invalid` |
| `requests.json` | 真实 operationId、方法、完整路径、认证、请求体类型和声明状态；executable=false |
| `capture.jpg`、`frame-request.template.json` | 811 字节、16×16 JPEG；完整 Base64，streamId/frameId/时间刻意保留变量，不可原样发送 |
| `read-only-probes.sql` | 按设备/客户/原始消息/seq 精确限定的只读查询及原生 PG 锁诊断，不含写入/迁移 |

校验器将业务候选与证据提交分开绑定：候选为 `d1a7b811`，新证据提交为 `1b1b879f`。完整 `pnpm verify` 的 1,713 份输入逐字节核对候选 Git 对象，22 阶段及七份新专项全部通过，13 份证据从不可变证据提交读取。当前工作区继续严格核对 1,693 份交付输入，涵盖业务、契约、IaC、其他脚本与根配置。

另有明确枚举的 20 份目标验收协议工具/导出元数据，独立通过 protocolDigest、生成文件 manifest 及本地回归绑定；不把这些后续准备工具冒充业务候选内已执行的版本。完整验证输入清单仍封存，排除清单必须精确等于固定的八个工具/说明文件及本包目录，不能排除任何业务、契约或 IaC 路径。旧 G3/IMG-21 证据保留。

新增准备脚本、AR12口径及本地回归依据、用例、只读 SQL 和共享引用解析器另有 `protocolDigest`；输入和 receipt 必须绑定同一个摘要。修改执行包后必须重新生成，不得继续套用旧 receipt。G3 的完整 verify 是候选历史证据，本批新增工具的本地检查单独记录。

```bash
node scripts/device-image-target-package.mjs --generate
node scripts/device-image-target-package.mjs --check
```

两条命令都不访问网络；第二条要求文件集合与内容逐字节一致。缺失、额外文件、源码/证据/包漂移均返回非零，不重建或修补旧 G3 证据。

## 2. 扩展套件的环境、身份和权限输入

复制输入和 receipt 到同一独立 run 目录；用例实际执行前，环境负责人应提供以下信息。生成模板仍保留空值；当前候选未执行真实准入核验，后续实际材料必须单独保存在审计 evidence run 目录，不能把模板或历史输入当作本轮真实状态。不要从历史 QA09 材料照搬账户、设备、URL、Secret ARN 或部署结论。

| 输入 ID | 提供方 | 约束与来源 |
|---|---|---|
| accountId / region / stackName | 环境负责人 | 实际隔离环境、12 位账户、区域、栈；输入不等于实际权限已获授 |
| adminBaseUrl / deviceBaseUrl / webOrigin / mqttEndpoint | 环境负责人 | 实际 HTTPS 入口含正确路径前缀；webOrigin 为精确 origin；MQTT endpoint 仅登记、不连接 |
| deployedCommit / deploymentProof | 发布负责人 | 必须精确等于候选；已部署版本证据，不能拿本地 synth 或 Git HEAD 代替 |
| migrationProof / nativePgReadRef | 数据库负责人 | 目标 schema SHA、44 项已应用迁移、无待迁移；只读凭据的逻辑引用，本批不取得或使用凭据 |
| controlTable / payloadTable / archiveBucket / runtimeVersionsProof | 云端运维 | 由实际栈输出和运行配置提供；核对两表、IAM/VPC endpoint、各运行版本，权威写入口均使用同一候选 |
| deviceId / customerId / otherDeviceId / otherCustomerId | 环境负责人 | 两台隔离设备、两个不同客户；先记录归属/生命周期/运行状态/白名单基线 |
| deviceMtlsRef / otherDeviceMtlsRef / mqttIdentityRef | 身份负责人 | 主设备及一次性设备的独立证书引用和MQTT引用；证书指纹、有效期、登记状态另外核对；不在包内放 PEM 私钥 |
| viewerARef / viewerBRef / rejectedIdentityRef / otherTenantRef | 身份负责人 | 两个独立viewer、当前撤权/零角色等整个请求被拒绝的身份和跨租户身份；不要求制造V1不存在的仅缺图片权限角色，不手改JWT角色 |
| authorityWriterRef | 云端运维 | 已包装的权威写入口/受控测试作业引用，恢复操作身份必须独立于被撤权的测试身份；不能用裸 SQL 或另建原始 client 绕过失效协议 |
| testScopeProof / executionWindowProof | 验收执行负责人 | 本轮资源范围、可执行操作与时间窗、独占 runId；本次准备授权不等于目标执行授权 |
| nativeWindow / faultPlan | 数据库/云端负责人 | 原生 PG 多连接、多进程、真实 DDB；故障范围/时限/恢复办法，最多本轮两台隔离设备 |
| longWindow | 验收执行负责人 | 真实至少 24 小时窗口；不得回写数据库时间或借 fake clock 宣称目标终态通过 |
| scaleAndSla | 业务/运营负责人 | 启用数、单设备并发查看数、首帧等待目标、网络条件；未知不得自填默认目标 |
| sequenceReservation | 设备接入负责人 | 原始 MQTT 序号基线与独占号段，至少预留六条；不得重置真实设备计数或与第三方同时占用同一号段 |
| cleanupPlan | 云端运维 | 按资源台账恢复/保留/删除的边界，保留历史关联与 CONTROL epoch；没有全桶清理或批量关设备 |

`ref:` 是逻辑定位符，例如 `ref:secure-run/viewer-A`，不是 Token、密码、数据库 URL 或本工具会解引用的真实 Secret。实际持有和注入由后续授权执行器管理。输入 proof 使用 `{path, sha256}` 引用同一 run 目录内的脱敏 JSON；拒绝绝对路径、`..` 和符号链接越界。

每份 proof 必须含 `mode: TARGET_CLOUD`、`syntheticResponsesAllowed: false`、候选 sourceCommit、与输入一致的 accountId/region/stackName、inputId、真实材料得出的 passed 和 details。只填 `passed:true` 无效。下面的 required details 均需外部材料，不由本包生成“已通过”值：

| proof | 必要 details |
|---|---|
| deploymentProof | deployedSourceCommit；versions.adminApi/deviceApi/ingestion/mediaEvidence/outbox |
| migrationProof | schemaSha256；完整且排序的 appliedMigrations（44 项）；pendingMigrations=[] |
| runtimeVersionsProof | 上述 versions；LIVE_IMAGE_CONTROL_TABLE/PAYLOAD_TABLE 与输入一致；allAuthorityWritersOnCandidate，附完整权威写入口版本清单供来源复核 |
| testScopeProof | isolated=true、mayMutate=true；精确两台 deviceIds、两个 customerIds；retirementAuthorized=true、disposableDeviceIds仅包含otherDeviceId |
| executionWindowProof | startsAt、endsAt、permittedCloudCases=true，覆盖整轮真实执行时间 |
| nativeWindow | databaseEngine=POSTGRESQL_NATIVE、storageEngine=AWS_DYNAMODB；至少两个独立进程和两条独立 PG 连接 |
| faultPlan | caseIds 覆盖 NC01～NC12、maxAffectedDevices=2、restoreRequired=true、rollbackPlan |
| longWindow | startsAt/endsAt 间隔至少 24h，targetClockUnmodified=true |
| scaleAndSla | enabledDevices>0、concurrentViewersPerDevice 为1～16、firstFrameTargetMs>0、networkProfile；这些不是本包批准的负载规模 |
| sequenceReservation | deviceId、firstSeq/lastSeq、exclusive=true、originalCounterRecorded=true；号段不超 PostgreSQL Int 上限 |
| cleanupPlan | usesResourceLedger、disableThroughAuthorityWriter、preserveControlEpoch、preserveHistoricalLinks、deleteOnlyOwnedKeys 均为 true；retentionDecision |

```bash
node scripts/device-image-target-package.mjs --admission docs/api/fixtures/device-image-target/inputs.template.json
```

初始输出 BLOCKED、列出35个缺项及提供方，退出码 **2**。AR12旧可达性阻塞按[明确口径](./device-image-AR12-acceptance-scope.md)改为单一、受源码约束的NOT_APPLICABLE，不再另加一项永久阻塞。输入填齐并满足proof结构后可为PASS_INPUT_STRUCTURE_ONLY，不证明凭据/部署/授权材料真实，也不执行任何目标操作。

**AR12记录：** V1五种固定角色均有media:read，“源查询200但仅省略图片字段”的组合不可通过切换正常角色构造。只将AR12/no-media-permission以决策AR12-V1-MEDIA-OMISSION-NA-1、固定候选/源码摘要及本地ALARM/EVENT拒权回归记录为NOT_APPLICABLE；不标目标PASS、不挂目标evidenceRefs，不免除AR12其余五个目标变体。源码、候选或本地回归发生漂移则恢复ar12ScopeRevalidationRequired BLOCKED；错用N/A或旧摘要receipt拒绝。不会改V1权限矩阵或添加假角色。

## 3. 五个预览接口执行用例（PV01～PV14）

执行前先取实际版本、迁移、IAM/路由和输入准入证据。预先已批准准入的隔离设备与默认关闭设备分别使用；本包不进行 opt-in/白名单启用。云端用例可由模拟设备客户端发送固定 JPEG 测试字节，不要求 App 源码或真实相机。这是合成**请求输入**，目标响应、持久化与运行日志仍须真实，不能采用 mock **响应**。

1. 设备 mTLS `GET /api/v1/device/live-image/state`：关闭能力 403；已启用无人查看 IDLE，每 5000ms 查询。
2. 平台 JWT `PUT /api/v1/admin/devices/{deviceId}/live-image/viewers/{viewerId}`：新 UUID，每页不同、无请求体（不能发 `{}`）；200 得 streamId、30 秒租约、10 秒续租、2000ms 读周期。
3. 设备重新 GET state：ACTIVE 当前 streamId、activeUntil、2000ms 上传周期、131072 字节图上限。
4. 设备 `POST /api/v1/device/live-image/frames`：application/json，使用当前 streamId、新 frameId、测试帧构造时的 UTC 时间、JPEG 标准 Base64；同请求重试保持全部字段。最多一个上传在途，未完成跳过下一次采样，不能排历史帧。
5. 平台 `GET /api/v1/admin/devices/{deviceId}/live-image/latest?viewerId=...`：先 WAITING_FRAME，上传后 READY；之后加 `knownFrameId` 应 UNCHANGED、无 Base64、截止不延长。
6. 两身份各续自己的租约、释放一页另一页继续；`DELETE .../viewers/{viewerId}` 无 body 返回204。最后释放后 IDLE，新开流不同，旧流不能上传或读取。

PV03～PV14 还包括：独立帧/租约到期；原图 131072/131073、JSON 184320/184321 字节及像素边界；JPEG/MIME/Base64 负例；2 秒时钟超前界限、旧帧/内容冲突、15 秒去重；1000ms 服务端新帧限频/Retry-After、第17 viewer；当前身份和租户；CORS、禁缓存、跨实例共享及运行入口权限。

按 `cases.json` 的具体断言逐项记录，不以单次 200 覆盖整个用例。PV08/12 的所有规定变体都必须有独立 evidenceRefs。应用 400/401/403/404/409/413/415/429/503 使用冻结错误结构；mTLS 握手和网关先行拒绝单独记录为传输/网关证据，不要求它们伪装成应用 JSON。

CORS 由实际浏览器 Origin 与 OPTIONS 验证：精确允许来源，方法和请求头受限，ETag/X-Request-Id/Retry-After 可读取，预览 no-store。只用 curl 得到200不能证明浏览器 CORS 可用；不得把 admin JWT 放到设备端或伪造可信 Gateway 证书 Header。

## 4. S3 与 event/alarm 留档（AR01～AR14）

使用[实时包](./device-live-image-vendor-guide.md)与[留档包](./device-archive-vendor-guide.md)的冻结字段。留档原图仍是 S3 二进制；不会调用实时帧接口来登记事件图片。

1. 分别执行 EVENT/ALARM × source-first/media-first 四个用例。原触发和每条 media 各有新的原始 meta.id/seq/UTC；完整报文按原 Schema 校验，存在 audit 的类型须用原计算函数重算。禁止只改 meta 后沿用旧 Hash、重发静态样例时间或猜测设备当前序号。
2. 原 Event/ACTIVE Alarm 优先发送；对固定原 JPEG 申报 mediaType=IMAGE、fileName、sizeBytes=811、sizeKb=1、SHA-256、triggerRef.kind 和**原触发 meta.id**。
3. 设备 mTLS `POST /api/v1/device/media/upload-sessions`：201 新办；同申报有效重用200，保留 session/path/createdAt/绝对截止；有效重用不占新额度。同引用合法但变申报409 MEDIA_TRIGGER_CONFLICT，不能误当完成。
4. 普通 HTTPS PUT 返回的完整 URL、原 JPEG 字节、精确 Content-Length；按实际 SignedHeaders 发送必要 Header。checksum 在 query 时原样保留，在 Header 时发原 SHA-256 的 Base64；不附 JWT、REST mTLS 证书，不重建 query，不把 ETag 当业务 Hash。记录 S3 请求ID/结果/字节Hash，**不记录完整 URL**。
5. S3 成功后向自身 media Topic 发原字段 objectPath（逐字符取响应值）、captureTime、sizeKb等。PUBACK/S3 2xx 都不是业务登记；同一申报重复 POST 得409 MEDIA_ALREADY_REGISTERED + mediaId 才确认登记。没有 GET 登记状态或 receipt 查询接口。
6. 持久层证明同事务 MediaObject + PENDING Evidence + COMPLETED session + ingestion receipt + Outbox；正常 worker 和分钟扫描解析原触发，精确同租户/同设备/sourceMessageId，最终查询 AVAILABLE。
7. `GET /api/v1/admin/alarms/{alarmId}`、`GET /api/v1/admin/events`、`GET /api/v1/admin/media/{mediaId}/download-url` 实测有权、跨租户、未关联null、AVAILABLE、DELETED、下载失败，以及清除后原ACTIVE图片仍可读。仅缺media:read时省略字段的实现分支按AR12源码N/A决策与本地拒权回归记录，不拿整个请求被拒绝的响应冒充该分支。

AR05～14 要求真实重用/过期新办、签名头负例、精确字节/Hash、重复MQTT、新旧会话竞争、清除前后、两链路配额独立、旧请求/历史媒体兼容。900秒会话到期和24小时关联终态使用真实窗口，不修改目标时钟或人为 backdate 数据库代替观察。每分钟默认50行×5页 keyset 扫描，真实多消费者和有界重试记录保留。

配额耗尽步骤归入 AR14，必须在所有需要新签发的 AR/NC 用例之后；AR05 先验证并发重用，AR07 再验证到期新办。旧请求201也必须在耗尽之前执行。整轮序号和会话预算须由执行负责人按44项及重试预留，模板“至少六条”只是类型最低约束，不是整轮足够预算；不得重置计数，必要时跨真实UTC日排期。未上传的本轮会话/触发记录按台账保留与过期，不直接删行返还额度。

同 code 的两次独立告警须先 CLEARED 再产生新的 ACTIVE/meta.id；四种先后顺序用例与AR11各自记录独立原始消息，不能在尚未清除的上一条告警上误判第二次关联，也不能清除非本轮现场告警。

ALARM 始终引用 ACTIVE meta.id；CLEARED 自有新消息ID，不按 alarm code 猜图。MQTT HIGH 在管理 REST 表达为 MAJOR，不改原MQTT报文。DELETED 的测试操作只能由批准的受控维护作业按资源台账执行；本包没有新增媒体删除 HTTP 接口。

## 5. 原生存储、并发、撤权和异常恢复（NC01～NC12）

后续在已授权隔离执行作业中调用真实适配器，至少两个进程/两条原生 PG 连接；不能用 Promise 并发、单连接 PGlite 或 SDK 命令快照替代。本文的屏障/故障步骤是后续执行器需落实的条件，本批不启动执行器、不创建云作业或安装原生服务。

| 重点 | 可判定的不变量与证据 |
|---|---|
| DDB CAS/事务 | 首次并发租约同流不丢；最后释放与上传共享 CONTROL 线性化点；CONTROL/FRAME/DEDUP 原子一致，旧帧不覆盖新水位；重复/冲突/限频按原期限判定 |
| DDB 键与TTL | CONTROL 表 `pk=DEVICE#id, sk=CONTROL` 不设 TTL；PAYLOAD 表 FRAME、DEDUP#stream#frame 的 ttl 异步清扫。逻辑截止与物理删除时间分别记录，不能承诺 TTL 十秒内删除 |
| PG 鉴权锁 | `fdp:live-image:authority:v1` shared/exclusive advisory 屏障 → 设备/用户行锁 → DDB。记录两个独立 PID 和实际等待；已授权在途读排空后撤权提交，之后新读必须拒绝 |
| 权威失效 | 使用 [IMG-08 权威入口](../dev/IMG-08-共享存储运行入口与本地验收.md)：先关闭CONTROL、递增epoch、清流/租约，再SQL；提交后只恢复自己留下的版本。裸 SQL、另建未包装 client、混合旧部署不属于允许路径 |
| 八种授权变化 | NC06 的角色、账号、租户、证书、挂起、退役、取消分配、关闭白名单分别有变体证据；不能只测试一个403即标全部通过 |
| 截止和未知结果 | 锁等待1000ms、预览/恢复事务最多10000ms、I/O父预算限制；只确定条件冲突当CAS重试。未知写结果503后重新鉴权；迟到读不得泄漏，迟到写仍受版本条件/截止约束 |
| 回滚/恢复 | SQL回滚保持无部分提交；提交后恢复失败保持关闭，不能谎报SQL回滚。使用原权威入口显式恢复，新代次不得带回旧租约 |
| 归档并发 | 设备→触发→会话锁序；Hash I/O期间撤证/换租户在提交重验；登记Outbox失败同事务回滚，原消息重试；多消费者和分钟扫描最终唯一关联 |

DDB只收集CONTROL顶层 revision/authEpoch/customerId/streamId/enabled/activeUntilMs/水位及PAYLOAD键/ttl/摘要。**FRAME 的 payload 内有 Base64，不直接 dump 到日志或证据库。** PG只读 SQL按本轮设备/客户/消息限定；执行时由受控 psql 会话绑定值变量，不在命令行输出密码/连接串。原生 `pg_locks` 诊断只导出本轮 PID。

退役为终态：主设备A仅做可恢复的变更，退役变体使用已单独批准的一次性设备B，在B的跨范围检查完成后执行，随后按台账保留终态。不得通过裸SQL“恢复退役”。其余用例继续用A；故障恢复和关闭准入仍经独立权威写身份处理。

## 6. 扩展套件顺序、清理与完整性判定

推荐阶段：本地包 `--check` → 缺项登记与已部署环境证据 → PV01/02基本链路 → PV03～14 → AR01～13（并行预留真实24h观察）→ NC01～12受控窗口 → AR14配额耗尽 → OP01日志/OP02容量观察 → OP03清理 → OP04封存。JSON依赖是最低前置；不得在授权窗口未到、故障恢复失败、跨租户数据泄漏、错误目标或Hash/版本不一致时继续有风险写入。将后续用例记 BLOCKED/NOT_RUN，保留首次FAIL及重试批次。

每轮唯一 runId 形式 `IMG21-...`；执行前就登记资源类型、设备/客户、ID/完整对象Key、归属本轮与否、原状态摘要、恢复方法和保留决策。只处理台账内对象；释放测试viewer，经权威入口恢复准入/权限/归属，验证无活跃测试租约/遗留故障。**不删除CONTROL或倒退epoch，不删除历史关联，不扫全桶，不用“cleanup成功”掩盖未清理资源。** S3生命周期、软删除和必须保留的审计/receipt分别记录，无法清理项显式保留。

目标receipt每个用例必须覆盖全部目标断言ID；每份evidenceRef的JSON/Hash与candidate/protocol/runId/account/region/stack/caseId/时间窗一致。证据种类包括HTTP/GATEWAY/DEPLOYMENT/DB/DDB/S3/MQTT/WORKER/CLEANUP；DB须POSTGRESQL_NATIVE，DDB须AWS_DYNAMODB。规定的可达变体须逐项PASS且有variantId证据。唯一例外是AR12/no-media-permission：保留第六条变体记录为NOT_APPLICABLE、targetExecuted=false、目标evidenceRefs=[]，另有且仅有一条精确sourceExclusions记录绑定decisionId/sourceCommit/policyDigest。它不是目标PASS；其他变体或整项用例标N/A、删除该记录、假挂目标证据、旧摘要/旧输入形状均拒绝。不得借N/A覆盖实际FAIL/BLOCKED/NOT_RUN。

证据 JSON至少含 mode、syntheticResponsesAllowed、sourceCommit、runId、accountId、region、stackName、caseId、kind、capturedAt；DB/DDB另含engine，有变体时含variantId。HTTP建议data只留方法、路径模板、状态、requestId、字节数/Hash/截止与脱敏错误码；跨服务记录原sourceMessageId/seq、mediaId、Outbox ID和运行版本。不要存 Base64、Token、私钥、Cookie、完整签名URL；可将敏感字段置 `[REDACTED]`，原图仅在受控临时区保存并记录Hash。

CLEANUP证据data.entries必须非空，包含 id/resourceType/ownerRunId/deviceId/disposition（RELEASED/RESTORED/RETAINED/REMOVED），以及postChecks.activeTestViewerCount=0、faultConfigurationRestored=true、historicalLinksPreserved=true。拒绝外来run资源和删除DDB_CONTROL。`resources.template.json`是计划骨架，不是清理已完成的证据。

```bash
node scripts/device-image-target-package.mjs --receipt \
  docs/api/fixtures/device-image-target/receipt.template.json \
  docs/api/fixtures/device-image-target/inputs.template.json
```

模板返回NOT_RUN、退出2；缺项返回BLOCKED、错误/失败返回FAIL。具备全部目标结构材料且AR12源码N/A记录仍有效时，离线工具上限仍为 **PASS_STRUCTURE_ONLY、requiresRealExecutionReview=true，G4仍NOT_RUN**。有效N/A不再单独阻塞扩展套件完整性；44个用例及AR12五个可达变体若要声称扩展套件完成，仍须真实执行。离线文件校验不能证明材料来自真实云端；后续必须复核运行来源、部署/身份/持久化/观测链路，在独立G4报告判定。其余FAIL/BLOCKED/NOT_RUN、原生竞争/24h或来源证据缺失，均保留为扩展套件未完成，不能给该套件完整通过；它们不自动阻塞本页三项核心接口 Gate。核心链路失败及本轮清理失败仍阻塞接口 Gate。

第三方负责App与真机，云端执行器可独立完成CF01～CF03并交付G4；G5真机结论不参与接口Gate判定。当前提供方/环境输入缺失不妨碍本次准备材料交付，也没有授权本包自动运行目标用例。
