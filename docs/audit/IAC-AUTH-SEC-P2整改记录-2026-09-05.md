# IAC / AUTH / SEC P2 证据与文档整改记录（2026-09-05）

## 1. 整改结论

依据全面复盘报告 §4.3，本轮完成六份任务文档修复、证据 Gate 扩展和当前证据复核，P2 建议完成率为 **3/3（100%）**。

文档现在区分本地组件/模板证据与真实 AWS 验收。AUTH-04 AWS IoT 实网允许/拒绝矩阵继续按过渡方案延期至具备隔离测试账号的开发后期，不因文档或本地 Gate 通过而视为完成。

## 2. 完成情况明细

| P2 建议 | 完成内容 | 状态 |
|---|---|---|
| 修复六份任务文档 | 将 `docs/dev` 到 `infra`、`packages` 的链接统一修正为仓库根相对路径；DEC-012 更新为 `frozen@1.0.0`；移除日期化测试总数，改为稳定命令与审计快照引用 | CLOSED |
| 扩展证据 Gate | 将 IAC-01、AUTH-01～04、SEC-01 纳入默认文档集合；校验链接、`pnpm verify` 命令、易漂移计数及 DEC-012 登记/文档一致性 | CLOSED |
| 重新复核证据 | 执行文档 Gate、正负向脚本测试、P1 专项、构建与 CDK 0-warning synth；保留 AWS 实网验收边界 | CLOSED |

## 3. 文档同步内容

- IAC-01：同步 Node.js 24、证书包恢复 Sweeper、非本地 mTLS 失败关闭、KMS/IAM 语义扫描及 CDK warning Gate。
- AUTH-01：同步可信 Lambda 组合根与 DEC-012 冻结状态。
- AUTH-02：同步 PostgreSQL 共享原子限频，以及证书包确认和 Token 核销的同事务语义。
- AUTH-03：修复实现/测试链接并移除历史计数。
- AUTH-04：保留本地策略矩阵证据，同时明确真实 AWS IoT 回执仍延期、不能被本地求值器替代。
- SEC-01：同步两阶段交付、可重试恢复状态机、定时扫描和撤证成功后清密文的顺序。

## 4. Gate 与负向测试

证据 Gate 新增以下失败条件：

1. 六份任务文档任一仓库内链接不可解析；
2. 缺少当前全仓证据命令 `pnpm verify`；
3. 固化测试文件数、用例数或 `x/x` 历史结果；
4. AUTH-01 的 DEC-012 声明不是 `frozen@1.0.0`，或决策登记本身发生漂移。

负向样例覆盖缺命令、历史计数和陈旧 `pending` 状态；正向样例及当前十三份受检任务文档均通过。

## 5. 验证结果与遗留边界

| 验证项 | 结果 |
|---|---|
| `node scripts/check-eng-db-dom-evidence.mjs` | PASS |
| `node --test scripts/check-eng-db-dom-evidence.test.mjs` | PASS，正负向用例全部通过 |
| P1 专项测试 | 7 files / 67 tests PASS |
| Migration / Schema / boundaries / secrets / sinks | PASS |
| Build / typecheck / CDK synth | PASS；CDK 0 warning |

全仓 `pnpm verify` 的已知非 P2 阻断仍是 prototype 与正式 OpenAPI 的 `listMedia`、`createOtaCampaign` 重复。该问题在 P1 整改前的起始 HEAD 已存在，本轮没有越界修改 CT/BE 契约；应作为独立契约任务处理后重新生成 bundle。
