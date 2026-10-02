# QA-09 Worker CA 链 AWS 内只读诊断

执行器固定测试账号、区域、唯一Worker角色和CA Secret，先核验默认策略/ServiceBoundary/Secret KMS元数据及临时策略不存在；读取当前Device API的固定版本公共truststore并核验无私钥。诊断算法用Node X509，与Worker链校验条件一致；仅返回字段有效性、指纹、有效期、链关系、签名及密钥匹配布尔值。

```sh
node --test scripts/qa09-ca-chain-diagnostic.test.mjs
node scripts/run-qa09-ca-chain-diagnostic.mjs docs/audit/evidence/<新诊断回执>.json
node scripts/check-qa09-ca-chain-diagnostic.mjs docs/audit/evidence/<新诊断回执>.json docs/audit/evidence/<新Gate回执>.json
```

每次使用新回执路径，不覆写历史证据。真实Secret只在AWS诊断Lambda内存中读取，不能在本机调用diagnoseCaChain处理真实Secret。Lambda使用原Worker角色、原临时CA解密策略和原到期时间，发布唯一版本，校验CodeSha/Role/Active后调用；已有Worker代码不更新。函数使用现有Worker日志组，无Secret输出，不配置公共函数URL或触发器。finally删除唯一函数、撤销原临时CA策略并核验默认策略与Boundary未变。未知操作结果通过精确名称和CodeSha回读；无法确认归属或策略漂移时停止删除并输出清理FAIL。

回执门禁要求AWS执行绑定、固定返回结构和全部清理PASS；未知字段、PEM、任意错误文本或缺清理失败关闭。诊断Gate PASS允许workerChainValid=false，因为它证明诊断执行完成，不代表链配置或全业务验收通过。

[本轮真实执行与根因](../audit/QA-09-WorkerCA链AWS内受控诊断记录-2026-10-02.md)。
