# BE-CERT-02 Certificate Rotate API

实现：[apps/cloud-api/src/device/certificate-rotate.ts](../apps/cloud-api/src/device/certificate-rotate.ts)（Service）、[rotate-handler.ts](../apps/cloud-api/src/device/rotate-handler.ts)（API）、[apps/ingestion-worker/src/rotation-confirmation.ts](../apps/ingestion-worker/src/rotation-confirmation.ts)（首 Heartbeat 确认扩展点）；契约：[contracts/rest/device-certificate-api.json](../contracts/rest/device-certificate-api.json)；测试：[certificate-rotate.test.ts](../apps/cloud-api/test/certificate-rotate.test.ts)、[rotation-confirmation.test.ts](../apps/ingestion-worker/test/rotation-confirmation.test.ts)（PGlite 真实 PostgreSQL + 全部 migration + mock IoT）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-CERT-02（P1 / 设备接口），依赖 BE-CERT-01、SEC-01、AUTH-04、DEC-003（均已交付/暂定） |
| 端点 | `POST /api/v1/device/certificate/rotate`（Device mTLS，AUTH-03） |
| 响应 | `certificateId`、`certificatePem`、`privateKey`（仅本响应一次）、`effectiveDate`（UTC ISO）、`expiryDate`（UTC 日期） |
| 双证书窗口 | 新证书 ACTIVE + `rotatedFromId`=旧证书；旧证保持 ACTIVE 可用直至新证书首个合法 Heartbeat 确认 |
| 功能边界 | 不实现定时到期扫描和人工证书运维 |

## 2. 轮换与确认流程

**Rotate**（cloud-api）：AUTH-03 认证（旧证 ACTIVE 且属于设备，撤销/过期 → 401）→ `currentCertificateId` 必须等于身份证书（错误/跨设备 → 403）→ 同旧证书未确认轮换已存在 → 409 CONFLICT（DEC-003 失败关闭，重试不产生新证书）→ AWS 发证 + AUTH-04 单设备 Policy（幂等）+ attach → 新证书 ACTIVE（rotatedFromId 记录窗口）+ CERT_ROTATION_START 审计 → SEC-01 信封加密封包 → 返回明文包。

**Confirm**（ingestion-worker，BE-IOT-04 调用）：心跳证书为轮换新证书（ACTIVE + rotatedFromId 非空）且旧证仍 ACTIVE → 事务内条件更新旧证 REVOKED（并发仅一个生效）+ SEC-01 销毁新证书包 + CERT_ROTATION_CONFIRM 审计；确认后/非轮换证书的心跳由预检静默幂等。

## 3. 验收基准与证据

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 旧证书错误/撤销/跨设备均拒绝 | 缺字段 400；与身份不符（含他设备证书）403；撤销 401 | ✅ |
| 重试不产生无限证书 | 未确认轮换重复请求 409，AWS 发证调用恒为 1，证书行不增 | ✅ |
| 部分失败可重试 | attach 失败 → 500 且无孤儿业务记录；重试成功（有界替换） | ✅ |
| 切换前旧证可用 | 轮换后旧证书 AUTH-03 认证仍通过（双证书窗口） | ✅ |
| 确认后旧证禁用 | 首 Heartbeat 确认 → 旧证 REVOKED + revokedAt，旧证认证 401 | ✅ |
| 敏感包销毁证明 | 确认后新证书 packageCiphertext 为 null + CERT_PACKAGE_DESTROY 审计 | ✅ |
| 幂等 | 并发确认恰一个生效；重复确认/非轮换 Heartbeat 无副作用 | ✅ |
| 私钥安全 | 私钥不落库、不进审计（序列化扫描） | ✅ |

`pnpm vitest run apps/cloud-api/test/certificate-rotate.test.ts apps/ingestion-worker/test/rotation-confirmation.test.ts` 7/7 通过；`pnpm --filter @fdp/contracts test` 143/143 通过；全仓 `pnpm verify` 退出 0（2026-08-27）。

## 4. 对接说明

- **BE-IOT-04**：Heartbeat 认证后并列调用 BE-ONB-04 与 BE-CERT-02 两个确认扩展点；
- **BE-CERT-01**：设备可通过 status 接口观察新证书状态（新证 ACTIVE 后查询即生效）；
- **运行时**：IoT Port 生产适配器与 `packageRetentionSeconds`（DEC-003 冻结值）由部署接线注入。

## 5. 未决风险

- 设备丢失 Rotate 响应明文包后，因 DEC-003 失败关闭（409）无法自助恢复，需走运维重签（吊销未确认新证后重新 rotate）——DEC-003 冻结时应确认该取舍；
- AWS 发证成功但 DB 落库失败产生 AWS 侧孤儿证书（与 BE-ONB-03 同一风险，运维对账清理）；
- BE-IOT-04 未交付，确认扩展点暂无生产调用方。
