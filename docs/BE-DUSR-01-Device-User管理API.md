# BE-DUSR-01 Device User 管理 API

实现：[apps/cloud-api/src/admin/device-user](../apps/cloud-api/src/admin/device-user/index.ts)；OpenAPI：[contracts/rest/admin-device-user-api.json](../contracts/rest/admin-device-user-api.json)；验收测试：[admin-device-user.test.ts](../apps/cloud-api/test/admin-device-user.test.ts)（7 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DUSR-01（P1 / 管理后台后端），依赖 AUTH-01、DB-02、DOM-03（均已交付） |
| 账号分离（DEC-004） | 独立 `device_users` 表，与云端 Cognito 用户分离、不赋予云端登录权限；冻结前不实现 KDF 计算——API 仅接受预计算验证材料（verifierValue≥16 / verifierSalt≥8），**拒收明文密码字段**（password/plainPassword/passwordHash → 400）；DTO/审计永不返回验证材料 |
| 租户 | CustomerAdmin 只能管理自身 Customer：创建强制 actor.customerId（入参被覆盖）；其余操作行级校验，跨 Customer → 404（不泄露存在性）；CustomerViewer 只读 |
| 权限矩阵（DEC-012） | device-user:write = PlatformSuperAdmin/CustomerAdmin（**Operator 无 device-user 权限**）；device-user:read = SuperAdmin/Auditor/CustomerAdmin/CustomerViewer |
| 同步版本 | `device_users.version`（migration `20260829120000`）兼作 If-Match 乐观锁与设备同步版本：任何用户/分配变化 version+1，并向受影响设备发 USERS_CHANGED（Outbox，topic `bnx/device/{id}/notification`，deviceAction=SYNC，每设备一条） |
| 停用 | ACTIVE→DISABLED（重复停用 409）；停用用户不可更新/新分配；`listDeviceUsersForSync` 仅返回 ACTIVE 用户 + ACTIVE 分配（BE-SYNC-01 的 Sync 读取路径，停用用户不进入新 Sync） |
| 分配 | 设备与用户同 Customer（跨 Customer → 409）、非 Retired；批量全成或全败；部分唯一索引 `device_user_assignments_one_active` 兜底重复分配；历史 append-only（ACTIVE/REVOKED + revokedAt） |
| 功能边界 | 不保存设备端明文密码；不实现工单派遣/设备端申请 Topic |

## 2. 端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `POST /api/v1/admin/device-users` | `device-user:write` | 创建（201；(customerId, username) 唯一 P2002 → 409） |
| `GET /api/v1/admin/device-users` | `device-user:read` | 列表（customerId/status/keyword；含 ACTIVE 分配设备数） |
| `GET .../{deviceUserId}` | `device-user:read` | 详情 + 分配历史 |
| `PATCH .../{deviceUserId}` | `device-user:write` | 修改 displayName / 验证材料轮换（成对；If-Match + 强制原因） |
| `POST .../disable` | `device-user:write` | 停用（If-Match + 强制原因） |
| `POST .../assignments` | `device-user:write` | 批量分配（If-Match；201） |
| `POST .../assignments/revoke` | `device-user:write` | 批量撤销（If-Match；无 ACTIVE 分配 → 409 全回滚） |

## 3. 验收基准与证据（vitest + PGlite，7 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 跨 Customer 分配失败 | 跨 Customer 分配 409 且零写入/零通知/零审计（全成或全败）；CustomerAdmin 创建强制本 Customer、跨 Customer 详情/停用 404、列表隔离 | ✅ |
| 停用用户不进入新 Sync | `listDeviceUsersForSync` 停用后不再返回该用户；停用后不可更新/新分配/重复停用 409 | ✅ |
| 通知和审计正确 | 分配/轮换/撤销/停用每步 USERS_CHANGED 每受影响设备恰好一条（逐设备计数断言）；device.user.create/assign/update/revoke/disable 审计各恰好一次 | ✅ |
| 账号与 Cognito 分离 / 无明文密码 | 拒收 password 字段 400；DTO/审计不含 verifier；验证材料过短 400、轮换不成对 400；落库保存验证材料 | ✅ |
| 附加 | 用户名唯一 409；If-Match 缺失 400/漂移 409 VERSION_CONFLICT；部分撤销 409 回滚；Operator 读写 403、Viewer 写 403、未认证 401；DTO 与契约一致；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-user-api.test.ts`（3 项：端点/If-Match/Schema 封闭含脱敏与拒收明文密码）。

## 4. 未决风险

- DEC-004 未冻结：KDF 算法/参数未定，API 仅接受预计算验证材料；冻结后需补固定测试向量（BE-DUSR-02）；
- verifierSalt/verifierValue 长度校验为字符数代理（策略锁定字节下限 salt≥8/hash≥16）；
- USERS_CHANGED 实际 MQTT 投递依赖下行分发器（Outbox 归档链路）；
- 无用户恢复（enable）入口——任务范围仅停用，如需恢复需新任务定义。
