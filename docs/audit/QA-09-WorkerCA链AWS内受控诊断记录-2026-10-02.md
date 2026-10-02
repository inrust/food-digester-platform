# QA-09 Worker CA 链 AWS 内受控诊断记录

## 已确认根因

Worker实际使用CA Secret `fdp-test-device-ca`，AWSCURRENT版本 `c10bbb97-033c-4758-9bcb-e75bb6bd5fa9`。该版本的caCertificatePem、caPrivateKeyPem有值且匹配；caCertificateChainPem未提供非空字符串（本回执不区分键缺失、空字符串或非字符串）。运行时组合链只有1张中间CA，该证书不是自签根，末端无法自验证，因而触发原签发器的Invalid project CA chain。

公开Device API truststore固定版本 `FtN.3H5AydTqt6cgxf0wzeOcNQHFxCOx`含2张证书，顺序为同一中间CA → 根CA；CA标记、有效期、父签发关系和签名均通过。Secret中间CA指纹与truststore第一张完全一致，Secret私钥在AWS内同时验证与该证书及truststore第一张匹配。因此不需要更换中间CA、私钥、根CA或公开truststore；应补齐有效根链配置。

| 项目 | 真实结果 |
| --- | --- |
| Secret有效组合链数量 | 1 |
| 公开truststore链数量 | 2 |
| caCertificateChainPem有效非空字符串 | false |
| 中间CA指纹/私钥匹配公开truststore | true / true |
| 已配置Worker链校验 | false |
| 公开truststore完整链校验 | true |
| 缺失的根CA指纹 | `85:24:E4:39:20:F2:EF:7B:F8:8F:BC:F5:AC:27:4B:58:0C:82:F8:C0:3F:3C:FF:5E:31:AA:6C:7C:BE:31:39:52` |

具体签发器先将caCertificatePem与可选caCertificateChainPem拼接，再对每张证书核验CA标记、有效期、父签发关系和签名；最后一张必须自签。单张中间CA不能通过这一检查。诊断是只读，不尝试放宽该安全校验。

## 受控执行和绑定

账号065986019555/ap-southeast-1。本次临时函数 `fdp-test-qa09-ca-chain-a454cd8bef54c285`、发布版本1，使用原Worker执行角色fdp-test-onboarding-provisioning-role。未更新现有Worker代码或创建新角色。只在AWS内存中通过GetSecretValue读取固定Secret AWSCURRENT，私钥用于checkPrivateKey后释放引用；返回固定元数据结构，没有PEM、私钥、完整Secret、任意字段或底层异常文本。

公开truststore从Device API实时配置读取，以S3固定VersionId下载，并把公共证书随诊断源码打包。CodeSha256、Role及Active状态核验后只调用发布版本1，返回requestNonce/sourceHash绑定此次函数代码。现有Worker环境仍指向该Secret，当前WorkerCodeSha256与此前真实核验工件一致；诊断VersionId在事后DescribeSecret中仍为AWSCURRENT。[Worker绑定证据](evidence/qa-09-ca-chain-worker-binding-2026-10-02.json)。

使用原已批准、原到期时间的QA09DeviceCaDecrypt临时策略，仅指定CA Key/Secret/ViaService。结束后临时函数删除且查询不存在，临时策略删除且查询不存在，原Worker默认策略和FDP-ServiceBoundary一致；现有Worker日志组仅保留诊断运行审计日志。CA Secret和业务数据库均未写入；本机及GitHub没有获取CA私钥或Secret值，诊断未创建设备、Customer或登录身份。

## Gate与验证

只读诊断Gate PASS，表示真实执行、固定返回结构、源码/请求绑定和清理闭环通过。Worker链有效性仍false，完整QA-09仍PARTIAL / BLOCKED，不能宣称十设备或数据链路通过。

- `node --test scripts/qa09-ca-chain-diagnostic.test.mjs`：5/5 PASS，包含完整链、缺根、错误父证书/过期/密钥不匹配、超长链、异常数据防泄漏和严格回执门禁。
- `node --import tsx --test scripts/*.test.mjs`：340/340 PASS。
- `node scripts/run-qa09-ca-chain-diagnostic.mjs docs/audit/evidence/qa-09-ca-chain-diagnostic-2026-10-02.json`：真实AWS诊断和finally清理PASS。
- `node scripts/check-qa09-ca-chain-diagnostic.mjs docs/audit/evidence/qa-09-ca-chain-diagnostic-2026-10-02.json docs/audit/evidence/qa-09-ca-chain-diagnostic-gate-2026-10-02.json`：PASS。
- ESLint、Prettier、敏感信息/日志脱敏与差异检查：PASS。

[真实诊断回执](evidence/qa-09-ca-chain-diagnostic-2026-10-02.json)、[严格Gate](evidence/qa-09-ca-chain-diagnostic-gate-2026-10-02.json)、[结论汇总](evidence/qa-09-ca-chain-diagnostic-summary-2026-10-02.json)。回执包含诊断源码/handler Base64、哈希、CodeSha256、公开truststore版本和哈希以及仅元数据的实际返回。首次真实调用完成后未重复读取Secret。

## 下一可执行任务

以AWS内受控方式仅为新Secret版本补充caCertificateChainPem=上述公开truststore的根CA PEM，保留原caCertificatePem、caPrivateKeyPem及所有其他字段，保留原不可变Secret版本作为回滚基线。先核对AWSCURRENT仍是上述版本以及truststore固定版本；候选版本链/密钥/其他字段等价验证后才以版本条件推进AWSCURRENT，随后新前缀重跑十设备。任何Secret写入、版本Stage移动或执行身份写权限须按具体修复方案独立实施；本任务仅完成诊断，未修改Secret。

当前仓库ServiceBoundary仅列出SecretsManager读取操作，不能假定仅增加Worker内联写策略即可完成修复。修复阶段应另行核验实际Boundary并明确最小AWS内写权限，避免临时扩大本机SSO/GitHub的Secret读取能力。详见[根链补齐处置方案](QA-09-CA根链字段补齐处置方案-2026-10-02.md)。
