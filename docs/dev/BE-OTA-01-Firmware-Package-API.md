# BE-OTA-01 Firmware Package API

实现：[apps/cloud-api/src/admin/ota-package](../apps/cloud-api/src/admin/ota-package)（errors/storage/signature/service/handler）；REST 契约 [contracts/rest/admin-ota-package-api.json](../contracts/rest/admin-ota-package-api.json)；签名策略扩展点 [contracts/security/ota-package-signature-policy.json](../contracts/security/ota-package-signature-policy.json)；验收测试 [admin-ota-package.test.ts](../apps/cloud-api/test/admin-ota-package.test.ts)（13 项）+ 契约测试（4 + 6 项）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-OTA-01（P2 / 管理后台后端），依赖 AUTH-01（withAuthorization/权限矩阵）、IAC-01（OTA Bucket 已建，预签名接线属部署层）、DOM-03（audited/recordAudit） |
| 存储 | 复用既有 `firmware_packages` 表（DB-01/DB-02 已建，`@@unique([model, version, packageType])` + `sha256` 唯一），**无新增 Migration** |
| 功能边界 | 不实现设备端验签、安装和回滚（属 BE-OTA-03 设备侧）；病毒扫描服务未选型，仅保留 adapter 端口（缺省不装配） |

## 2. 关键设计

**API**（Cognito 认证；写 `ota:write` = PlatformSuperAdmin/PlatformOperator，读 `ota:read` = +Auditor；Customer 角色无 OTA 权限 → 403）：
- `POST /api/v1/admin/ota/packages/upload-sessions`（operationId `createFirmwareUpload`，对齐原型追溯）：声明 model/version/packageType/sizeBytes/SHA-256/签名 → 201 返回服务端生成 objectKey 的短期预签名上传 URL（900s 暂定值）。
- `POST /api/v1/admin/ota/packages/{packageId}/complete`：上传后校验 → VERIFIED。
- `GET /api/v1/admin/ota/packages`（筛选 + 键集游标分页）与 `GET /{packageId}`（详情）。

**上传会话**：objectKey 一律服务端生成（`firmware-packages/{model}/{packageType}/{version}/{packageId}`；model/version 限定 `[A-Za-z0-9._-]` 防路径穿越），客户端不可指定 Bucket/Key；同型号+版本+packageType / 同 sha256 重复 → 409（先读后写 + P2002 并发兜底）；uploadedBy 取身份上下文。

**上传后校验链**（complete，任一失败拒绝且保持 UPLOADED）：对象存在 → 大小一致 → SHA-256 服务端重算匹配 → 病毒扫描 adapter（INFECTED 拒绝）→ 数字签名验证 → 条件更新 `UPLOADED→VERIFIED`（并发兜底，仅一个完成者获胜）。

**签名格式由 DEC-022@1.0.0 冻结值驱动**：AWS KMS RSA-2048 SIGN_VERIFY，算法 `RSASSA_PKCS1_V1_5_SHA_256`，签名 base64 编码；规范载荷为 `FDP-OTA-SIG-v1` + model/version/packageType/sha256（小写 hex）固定顺序。服务端验签强制且失败关闭；信任根使用部署环境 `OTA_SIGNING_KEY_ARN` 带外注入，禁止内嵌或进入响应/审计。生产组合根接入 S3 HeadObject/流式 SHA-256/presigned PUT 与 KMS Verify adapter，verifier/策略算法错配仍以 409 失败关闭。

**不可变与可发布**：VERIFIED 为终态（RETIRED 流转属 BE-OTA-02），重复完成 → 409，成功包不可覆盖；包内容字段创建后无更新路径；可发布列表 = `status=VERIFIED`，UPLOADED（未完成上传/未完成校验）不进入。

**审计（DOM-03）**：`ota.package.upload_session.create` / `ota.package.verify` 经 `audited` 同事务写入（SUCCESS/FAILURE 如实记录）；签名/信任根材料不进入 afterValue。

## 3. 验收基准与证据（vitest + PGlite，13 项；契约测试 4 + 6 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| Hash 不匹配拒绝 | complete 时 SHA-256 重算不匹配 → 400，保持 UPLOADED | ✅ |
| 签名不匹配拒绝 | 签名对其他型号签发（型号不匹配即签名不匹配）→ 400；大小不匹配 → 400；对象缺失 → 400 | ✅ |
| 成功包不可覆盖 | VERIFIED 重复完成 → 409；同型号+版本+packageType / 同 sha256 重复创建 → 409 | ✅ |
| 未完成上传不进入可发布列表 | 未完成 complete 的包不出现在 `status=VERIFIED` 列表；UPLOADED 筛选可见 | ✅ |
| 签名格式由冻结值驱动 | DEC-022 冻结值、固定 RSA/SHA-256 向量与 KMS adapter 测试；verifier/策略算法错配 → 409；策略契约负向测试拒绝跳过验签、非失败关闭和内嵌信任根 | ✅ |
| 短期预签名 URL | 会话返回 https URL + 900s 过期时点；objectKey 服务端生成 | ✅ |
| 鉴权与输入校验负向 | 无 actor → 401；CustomerAdmin/Auditor 写 → 403、Customer 角色读 → 403；非法 packageType/sha256/sizeBytes/路径字符 model → 400；非法筛选值 → 400 | ✅ |
| 审计链 | create/verify 各 1 条 SUCCESS 审计，actor 正确 | ✅ |
| 不泄露内部信息 | 存储层错误（含 arn:aws 信息）→ 500 通用消息；详情不含 uploadUrl/signature/trustRoot | ✅ |

## 4. 未决风险

- **病毒扫描服务未选型**：仅保留 `MalwareScanner` adapter 端口，缺省不装配（不扫描）；选型后由部署层接线，Service 流程不变。
- **预签名 URL TTL（900s）与包大小上限（512MiB）为暂定值**：部署层签名器须与 TTL 一致；冻结时随签名机制一并复核。
- **目标 AWS 验收未执行**：S3/KMS 生产 adapter 与最小权限已静态接线，但真实上传、验签、URL 过期和密钥策略仍需隔离 AWS 环境回执。
- **大对象哈希**：complete 期间服务端流式重算 SHA-256，部署层需控制 Lambda 时长/内存（512MiB 包需流式实现，不得整包入内存）。
