# DEC-005 Media 文件与元数据保留期

DEC-005 是协议冻结门禁决策（当前 `pending`，登记版本 `0.2.0`）。按《管理后台开发任务清单》§4 末段，本任务把暂定值落地为数据驱动、可整体替换的策略扩展点。**决策本身未冻结，冻结必须经业务方批准人按 [decision-change-template.md](../contracts/decisions/decision-change-template.md) 执行。**

## 暂定值（provisional）

> RDS 保存元数据、S3 保存文件；具体期限待定。

| 策略面 | 暂定结论 | 消费任务 |
|---|---|---|
| 存储分离 | 元数据（mediaType、objectPath、Hash、observedAt 等）存 RDS；文件二进制存 S3 独立 Media Bucket；禁止互换或合并 | BE-MED-01、BE-ARC-02 |
| 保留期 | **待定**（`null`，fail-closed） | BE-MED-01、FE-14、BE-ARC-02 |

## 待冻结参数（fail-closed）

- `retention.metadataRetentionDays`：RDS 元数据保留天数；
- `retention.fileRetentionDays`：S3 文件保留天数；
- `retention.expiryAction`：到期处置行为（`delete` / `archive` / `delete-file-keep-metadata`）。

冻结前行为约束（已由测试锁定）：

- 不做任何自动过期/删除（`isAutomaticExpiryEnabled()` 恒为 `false`）；
- 查询接口按现有数据返回；
- FE-14 不得展示伪造的到期倒计时。

## 文件

| 文件 | 说明 |
|---|---|
| [contracts/media/media-retention-policy.json](../contracts/media/media-retention-policy.json) | 策略数据事实源 |
| [contracts/media/media-retention-policy.schema.json](../contracts/media/media-retention-policy.schema.json) | 策略结构契约（存储位置枚举锁定） |
| [contracts/media/media-retention-policy.ts](../contracts/media/media-retention-policy.ts) | 查询函数（`getMetadataStore`、`getFileStore`、`getMetadataRetentionDays`、`getExpiryAction` 等） |
| [contracts/media/media-retention-policy.test.ts](../contracts/media/media-retention-policy.test.ts) | 结构、负向、fail-closed 与一致性测试 |

## 使用约束

1. BE-MED-01 / FE-14 / BE-ARC-02 只能经 `media-retention-policy.ts` 查询；
2. BE-MED-01 可先实现元数据 RDS 表与 S3 上传会话（存储分离已锁定），但不得实现生命周期删除逻辑；
3. S3 生命周期规则属运维配置，由冻结值驱动，本策略不直接创建。

## 冻结升级路径

1. 业务方批准 DEC-005（登记升至 `>= 1.0.0`、`frozen`）；
2. 填入保留天数与 `expiryAction`，`status` 改 `frozen`，提升 `policyVersion` 并同步 `x-decision-versions`；
3. 消费方代码无需修改（数据驱动）。

## 验证命令

```bash
node --test "contracts/media/media-retention-policy.test.ts"
node scripts/check-decisions.mjs
node scripts/check-decisions.mjs trace contracts/media/media-retention-policy.json
```
