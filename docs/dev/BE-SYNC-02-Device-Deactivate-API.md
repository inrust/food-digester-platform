# BE-SYNC-02 Device Deactivate API

实现：[apps/cloud-api/src/device/deactivate.ts](../apps/cloud-api/src/device/deactivate.ts) + [deactivate-handler.ts](../apps/cloud-api/src/device/deactivate-handler.ts)；OpenAPI：[contracts/rest/device-deactivate-api.json](../contracts/rest/device-deactivate-api.json)；验收测试：[device-deactivate.test.ts](../apps/cloud-api/test/device-deactivate.test.ts)（7 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-SYNC-02（P1 / 设备接口），依赖 AUTH-03、DB-02、DOM-01（均已交付） |
| 数据 | 新增 `device_retirements` 表（[migration 20260828140000](../packages/database/prisma/migrations/20260828140000_device_retirements/migration.sql)）：BE-DEV-04 管理员 retire 创建 PENDING_CONFIRMATION；本服务确认后 CONFIRMED；每设备至多一条（Retired 终态，DOM-01 无出边） |
| 生命周期 | DOM-01：Retired 永久不可恢复；本服务不产生生命周期迁移，只完成退役确认与证书停用 |
| 功能边界 | 不负责设备本地数据删除或物理退役 |

## 2. 端点与关键设计

`POST /api/v1/device/deactivate`（DeviceMtls，身份即设备，无请求体）。

**顺序约束（BE-DEV-04 验收："不能先断证导致设备无法确认"）**：

- AUTH-03 `verifyDeviceCertificate` 对 Retired 默认 403（仅 Sync 有 DEC-014 限时例外），因此本端点使用**专用身份校验** `verifyDeactivateIdentity`：
  - 证书 ACTIVE + 有效期内 → 正常确认路径；
  - 证书 REVOKED 且对应退役记录 CONFIRMED 且撤销时间一致（即由本服务的完成步骤撤销）→ 判定为**重复确认**，幂等重放返回一致结果；
  - 其余（未登记/PENDING_CLAIM/EXPIRED/无关已撤销）→ 401；
- 确认与断证同事务：条件更新退役记录（PENDING_CONFIRMATION → CONFIRMED，并发漂移 → 409）→ 撤销全部 ACTIVE 证书（revokedAt 与 confirmedAt 同源）；
- 审计 `device.deactivate.confirm`（actorRole=DEVICE），afterValue 仅含 certificateId + fingerprint 摘要，绝不写入 PEM/私钥/证书包。

## 3. 验收基准与证据（vitest + PGlite，7 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 合法确认完成退役 | Retired + 待确认记录 → 200：CONFIRMED（DEVICE_CONFIRM）+ 证书 REVOKED + SUCCESS 审计；确认前通用 AUTH-03 校验对 Retired 403 而本端点可达（顺序正确） | ✅ |
| Active/Suspended 直接调用被拒绝 | 409 DEVICE_STATE_NOT_ALLOWED；证书不受影响；Retired 无记录 → 409 CONFLICT | ✅ |
| 重复调用结果一致 | 确认后（证书已撤销）重复请求 → 200 replayed，retirementId/confirmedAt/证书视图一致，无新审计/副作用 | ✅ |
| 写审计但不泄露证书材料 | 审计与响应序列化断言不含 PEM/证书包密文 | ✅ |
| 附加 | 未登记/无关已撤销证书/缺失身份 → 401；响应字段与 OpenAPI 封闭一致（含嵌套 retirement/certificates）；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/device-deactivate-api.test.ts`（3 项）。

## 4. 未决风险

- BE-DEV-04 管理员 retire 与跨模块回归已落地；完成方式包含 `DEVICE_CONFIRM`、`FORCE_COMPLETE`、`UNCONFIRMED_TIMEOUT`，撤证后的 Deactivate 重放仍按同源时间戳幂等返回；
- 重复确认的幂等判定依赖"证书 revokedAt 与退役记录 certificateRevokedAt 一致"（同事务同源时间戳）；若未来出现其他撤销路径共用该证书，需收紧判定（如记录确认所用 certificateId）；
- 设备确认后的接入面收缩（证书 REVOKED → 一律 401）由 AUTH-03 既有规则承担，本端点是唯一例外。
