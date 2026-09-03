# DEC-002 Topic Tier 标记

DEC-002 是协议冻结门禁决策（当前 `pending`，登记版本 `0.2.0`）。按《管理后台开发任务清单》§4 末段，本任务把暂定值落地为数据驱动、可整体替换的 Tier 登记扩展点。**决策本身未冻结，冻结必须经业务方批准人按 [decision-change-template.md](../contracts/decisions/decision-change-template.md) 执行。**

## 暂定值（provisional）

> 具体 Payload 示例优先；Telemetry/Report/Tamper 含 audit，Command 不含 audit。

Tier 决定 Topic Payload 信封是否强制携带 `audit`（含 `audit.hash`）：

| Tier | 语义 | Topic |
|---|---|---|
| `AUDITED` | 信封强制 `meta+audit+data`；`audit.hash` 必填 | telemetry、report、tamper |
| `STANDARD` | 信封为 `meta+data`，不含 audit | heartbeat、alarm、event、ack、media、cmd、ota、notification |

判定规则：以《Device-Cloud Communication Design》各类消息的 Payload 示例为事实源，不得由云端臆测添加或删除 audit。未知 Topic 的 Tier 查询失败关闭（`fallbackPolicy: deny`）。

## 文件

| 文件 | 说明 |
|---|---|
| [contracts/mqtt/topic-tier.json](../contracts/mqtt/topic-tier.json) | Tier 登记数据事实源（`tierVersion`、`x-decision-versions`、11 个 Topic 的 Tier 条目） |
| [contracts/mqtt/topic-tier.schema.json](../contracts/mqtt/topic-tier.schema.json) | Tier 登记结构契约（封闭 Topic 键集合） |
| [contracts/mqtt/topic-tier.ts](../contracts/mqtt/topic-tier.ts) | 类型与查询函数（`getTopicTier`、`topicRequiresAudit`、`listTopicsByTier`） |
| [contracts/mqtt/topic-tier.test.ts](../contracts/mqtt/topic-tier.test.ts) | 结构、负向与三方一致性测试 |

## 使用约束

1. 消费方（CT-03 Schema、BE-IOT-02 校验管线）只能经 `topic-tier.ts` 查询 Tier，禁止复制暂定值；
2. 三方一致性由测试强制：Tier 登记 ⇄ `topic-catalog.json` 的 `payloadEnvelope` ⇄ 11 个 MQTT Schema 的 `audit` 必填/属性；
3. `status: provisional` 期间，任何持久化设计不得把 Tier 判定固化为不可迁移结构。

## 冻结升级路径

1. 业务方按决策变更模板批准 DEC-002，登记升至 `>= 1.0.0`、状态 `frozen`；
2. 整体替换 `topic-tier.json` 并提升 `tierVersion`、`status` 改 `frozen`，同步更新 `x-decision-versions`；
3. 若 Tier 判定变化，同步更新受影响 Schema 的 `required`/`audit` 字段并重新运行 `scripts/generate-payload-types.mjs`；
4. 运行下方验证命令。

## 验证命令

```bash
# Tier 登记测试（结构/负向/三方一致性/覆盖）
node --test "contracts/mqtt/topic-tier.test.ts"

# 决策登记结构 + 契约版本一致
node scripts/check-decisions.mjs

# 追溯校验：Tier 登记与全部 MQTT Schema 的 x-decision-versions 与登记一致
node scripts/check-decisions.mjs trace \
  contracts/mqtt/topic-tier.json \
  contracts/mqtt/topic-catalog.json \
  contracts/mqtt/schemas/*.schema.json
```
