# BE-DEV-01 Device 台账查询 API

实现：[apps/cloud-api/src/admin/device](../apps/cloud-api/src/admin/device/index.ts)；OpenAPI：[contracts/rest/admin-device-api.json](../contracts/rest/admin-device-api.json)；验收测试：[admin-device.test.ts](../apps/cloud-api/test/admin-device.test.ts)（10 项，PGlite 真实 PostgreSQL）。

## 1. 范围与事实源

| 项 | 说明 |
|---|---|
| 任务 | BE-DEV-01（P1 / 管理后台后端），依赖 AUTH-01、DB-02、BE-CUS-02（均已交付） |
| 形态 | 只读查询接口（列表 + 详情）；不修改任何状态，不写审计（DOM-03 只管写操作） |
| 状态模型 | 生命周期 = DOM-01 九态；Operational = DEC-010 四态（device_latest_state）；连接状态由 `lastHeartbeatAt` 与阈值派生；授权 = DOM-02 License 状态 |
| 地域 | DEC-011：Region/Subregion 只取 Site 关系，设备不存地域真值 |

## 2. 端点与字段来源

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/admin/devices` | `device:read`（全五角色） | 筛选：customerId/siteId/region/subregion/lifecycleStatus/operationalStatus/connectivity/licenseStatus/model/keyword + 键集游标分页；Customer 角色强制本 Customer scope |
| `GET /api/v1/admin/devices/{deviceId}` | `device:read` | Customer 角色跨 Customer 或未分配设备 → 403 |

原型设备群表格字段来源：序列号/型号/硬件版本/厂商/生产日期/别名/固件/生命周期 ← `devices`；Customer/Site/Region/Subregion ← customer/site 关系；Operational/最新 Heartbeat ← `device_latest_state`；连接状态 ← `lastHeartbeatAt` 派生（阈值默认 10 分钟，`connectivityThresholdMs` 可注入，不写回生命周期）；证书摘要 ← 当前证书（ACTIVE 优先）的 certificateId + fingerprint（绝不返回 PEM/私钥/证书包）；License/Entitlement ← 有效状态优先的当前 License + 启用中的 Entitlement 编码；Contract 摘要 ← ACTIVE contract_devices → contracts。

筛选语义：四轴与其余条件以 AND 组合、互不覆盖；`connectivity=OFFLINE` 覆盖心跳超时/无心跳/无 latestState；`licenseStatus=None` 表示无任何 License，其余值为"存在该状态 License"；keyword 对 serialNumber/alias/id 大小写不敏感包含匹配。

N+1 控制：列表 = 1 次 `device.findMany`（关系 include）+ 1 次 `contractDevice.findMany`（IN 页内 id 批量），测试以计数器断言锁定。

## 3. 验收基准与证据（vitest + PGlite，10 项）

| 验收基准 | 测试 | 结果 |
|---|---|---|
| 原型设备群表格字段均有来源 | 全链路数据详情断言 19 个字段逐一命中来源（含 manufactureDate 日期格式、entitlements 仅启用项） | ✅ |
| 四轴状态可组合筛选且互不覆盖 | 目标设备四轴全中、4 个干扰项各偏一轴，组合筛选恰好命中；单轴语义独立验证 | ✅ |
| 连接状态派生不写回 | 阈值内/边界/超时/无 latestState 四种形态断言；查询后 devices 行 lifecycleStatus/updatedAt 不变 | ✅ |
| Customer 角色只看到授权设备 | 列表强制本 Customer scope（指定他人 customerId → 403）；详情跨 Customer/未分配 → 403；Auditor 平台只读 | ✅ |
| 无 N+1 查询回归 | 3 台设备列表：device.findMany=1、contractDevice.findMany=1（计数器断言） | ✅ |
| 不返回私钥或完整证书 | 响应序列化断言不含 PEM/私钥/证书包密文；仅 certificateId+fingerprint | ✅ |
| 附加 | region/subregion/siteId/model/keyword 筛选；非法枚举/游标 400；分页不重不漏；404/401；DTO 与 OpenAPI 封闭一致；错误码对齐 CT-05；无 AWS 依赖 | ✅ |

契约测试：`node --import tsx --test contracts/rest/admin-device-api.test.ts`（3 项：端点/筛选参数/四轴枚举齐备、Device 视图封闭且证书仅摘要、$ref 可解析）。

## 4. 未决风险

- 连接状态阈值（10 分钟）为暂定值：设备 Heartbeat 间隔的协议取值以《Device-Cloud Communication Design》为准，阈值可通过 `connectivityThresholdMs` 注入调整，不落库；
- "授权"筛选语义为"设备存在该状态 License"（Expired/Revoked 历史行亦可命中），展示用"当前 License"取有效状态优先；若需严格一致（筛选=展示口径），待 BE-LIC-01 落地后再收敛；
- Contract 摘要取该设备 ACTIVE 关联的第一条（DB 排他约束保证同设备有效关联时间段不重叠，实际至多一条）。
