# DEC-015 OTA 状态回传通道冻结记录

## 1. 变更元信息

| 字段     | 值                   |
| -------- | -------------------- |
| 决策 ID  | DEC-015              |
| 变更类型 | freeze               |
| 目标版本 | 1.0.0                |
| 批准人   | 业务方（用户确认）   |
| 批准时间 | 2026-09-04T10:16:25Z |

## 2. 冻结内容

- 唯一 OTA 状态回传通道为既有 `bnx/device/{deviceId}/ack`；不新增 `ota/status` Topic，不采用 AWS IoT Jobs 状态事件。
- ACK `data.objectType` 为强制判别字段：普通命令使用 `COMMAND` + `commandId`，OTA 使用 `OTA_TARGET` + `otaTargetId`，两类关联字段禁止混用。
- OTA 状态封闭为 `DOWNLOADING`、`INSTALLING`、`SUCCEEDED`、`FAILED`、`ROLLED_BACK`。
- `meta.seq` 继续作为设备级 ACK 接收幂等键；`meta.id` 作为消息 ID。设备身份必须与 Command/OTA Target 绑定设备一致。
- OTA 状态只允许按冻结状态机前进；相同状态为事件级幂等，越级、回退、未知 Target 或跨设备回执进入隔离路径。

## 3. 影响与边界

- CT-02 保持 8 个上行、3 个下行共 11 个 Topic；ACK 目录声明其承载两种封闭对象类型。
- CT-03 ACK Schema 和生成类型加入 DEC-015 追溯与 OTA 字段。
- AUTH-04 无需扩大权限：设备原有自身 `ack` 发布权限即为唯一入口。
- BE-OTA-03 状态接收可执行；OTA 发布/归档仍分别受 BE-OTA-02、DEC-016 约束。
