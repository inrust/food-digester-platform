# 运营交接：独立 License 验签与业务激活

状态：`PREPARED_NOT_DEPLOYED`；运营通道未提供，目标业务 `NOT_RUN`。本文件不是授权或部署回执，不含密钥。仅涉及测试账号 `065986019555` / `ap-southeast-1` 的 License 验签；不申请 OTA 签名权限。

## 运营需要交付

优先提供已有获权的独立验签通道及执行身份、调用授权、输入/输出契约和代码/版本回执。独立验签须使用测试环境实际签名密钥，在受控环境内部验证当前设备快照，不返回密钥，不以签名服务返回“匹配”代替独立算法验证。

若选择新建 verifier，运营可审阅以下准备源代码并自行处理精确 Secret/KMS 读取、调用方及部署权限。历史最小权限提案仍为 `PROPOSED_NOT_APPLIED`；执行器不会创建/修改 IAM 或 KMS。现有 API/Replay/Migration 角色不作为替代身份。

当前准备入口要求 `fdp-test-qa09-license-verifier-role`；这是此实现的身份约束，并非要求运营必须新建该名称。采用其他现有服务时，须先审阅适配及可信执行身份的验证方式，不能通过移除角色校验来接受任意执行环境。

## 可审阅源代码包

从本报告所随提交取以下四个文件，保持同目录及原字节，入口为 `license-hmac-verifier-entry.handler`：

- `scripts/license-hmac-verifier-entry.mjs`
- `scripts/qa09-a2-controlled-worker.mjs`
- `scripts/qa09-device-license-verifier.mjs`
- `scripts/qa09-firmware-fixture.mjs`（现有 worker 的静态导入依赖；License 入口拒绝固件签名操作）

SHA-256 见 [summary.json](summary.json) 的 `sourceSha256`、`workerSourceHashes` 与 `sourcePackage`。本地源码 ZIP 未包含云 SDK，未上传、部署或调用。以下命令在仓库根目录可重建相同摘要的源码包；不得把该包直接当作已经验证的运行工件：

```sh
python3 - <<'PY'
import pathlib, zipfile
names = ['license-hmac-verifier-entry.mjs', 'qa09-a2-controlled-worker.mjs',
         'qa09-device-license-verifier.mjs', 'qa09-firmware-fixture.mjs']
target = pathlib.Path('build/license-hmac-operations-2026-10-22/verifier-sources.zip')
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    for name in names:
        entry = zipfile.ZipInfo(name, (2026, 10, 22, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        package.writestr(entry, (pathlib.Path('scripts') / name).read_bytes())
PY
```

运行环境需支持 Node.js 24，提供 `@aws-sdk/client-sts` 与 `@aws-sdk/client-secrets-manager`，并验证 SDK 加载、STS 执行身份和调用路径。不要将三个 worker 依赖合并/裁剪：`a2SourceHashes()` 在运行时读取它们的原始文件。完整部署包及依赖、运行时版本、Lambda CodeSha256/固定发布版本须由运营另行绑定；当前包摘要只覆盖源码。

环境变量 `FDP_LICENSE_VERIFIER_APPLICATION_COMMIT` 固定为后续实际核验的应用提交。它不自动核验应用部署，执行测试前必须另外核对实际目标版本。当前新设备、快照、nonce 及应用部署绑定均为 `UNBOUND`，不能复用上一轮已清理设备或旧五分钟输入。

只允许读取验签器中固定的测试 License Secret / `AWSCURRENT`；底层 KMS 解密范围及 Secrets Manager 条件由运营审阅。无需数据库权限，也无需 OTA `Sign` 权限。不得配置 SecretString 为 Lambda 环境变量或输出到日志。调用路径不得启用请求/响应全文日志。

## 获权后的本轮执行顺序

1. 验证通道身份、精确代码/依赖及应用部署版本；验证只返回白名单回执字段，并能拒绝错误操作、提交、来源摘要、过期输入和异设备绑定。验证器返回的 `keyExported=false` 只是协议字段，仍需审阅代码、部署和日志配置。
2. 新建 `syncprobe-<随机16hex>` 隔离软件设备和对应唯一 `SYNC-<大写16hex>` 型号，通过真实 CSR、管理员审批、项目 CA 发证、首次 MQTT Heartbeat，随后通过管理 API 创建 Customer/Site、分配及有效 License。保存实际 UUID、证书指纹和只读归属证明。
3. 使用设备 mTLS 取得完整 Sync 快照；保留原始 License `signaturePayload` 的完整 UTC 时间戳、排序的线协议 entitlements、签名、版本及实际 ETag。构造 `LICENSE_VERIFY` 输入，绑定应用提交、四字段 `deviceBinding`、实际 device/customer、64hex ETag/证书指纹、32hex 随机 nonce 和不超过五分钟的过期时间。`sourceHashes` 按 `a2SourceHashes()` 的返回顺序产生。
4. 在获权通道独立验签。保存来源、执行身份、实际 Secret VersionId、canonical/signature 摘要、上述绑定和执行时间；验证篡改签名/原文等负向输入确实被拒绝。错误绑定和过期输入应在取密钥前拒绝；生产密钥始终不交给本机。单元测试的假密钥负例不能代替目标通道负向证明。
5. 仅在独立正向证据通过后，用设备 mTLS 提交 `RECEIVED`，再提交 `VERIFIED`；二者必须引用同一个实际已服务快照的 licenseId/version/ETag、当前分配和证书。`RECEIVED` 响应可能有新 ETag，不能直接换成新 ETag 提交 `VERIFIED`，除非已为该新绑定完成 `RECEIVED`。遵守服务端近 24 小时快照/确认有效期，验签输入仍须五分钟内有效。
6. 只读核对设备 `Assigned → Licensed → Active`、latest state `Active`、唯一 `Licensed → Active` 的 DEVICE actor 历史、设备状态审计以及 License 对象的 `device.license.verified` 审计绑定。重复确认不得新增生命周期迁移；使用未服务 ETag/错误版本等确认得到契约 `409 CONFLICT`。核对最终 Sync 契约与实际云端记录，不将管理员 License 状态等同于设备生命周期。
7. 无论成功或失败，只清理本轮拥有的业务夹具、证书、Thing、归档对象版本、临时 Cognito 身份，以及确属本轮临时部署的 verifier。独立读回不存在/为空，保留审计、日志和必要业务墓碑。运营提供的长期角色、密钥及其他服务不在自动清理范围。

现有 [REST Sync 实测执行器](../../../../scripts/run-rest-sync-smoke.mjs) 仍明确跳过独立验签和 `VERIFIED`，不能直接重跑后宣称完成本轮。获得通道后还需接入真实回执校验、确认流程和目标清理证明；本文件是可审阅的交接方案，不是已运行的闭环执行器。
