# QA-09 b552237 合同 await 微任务分界目标复验

源码：`b5522378aebca9340a0767b53ed3bab846ffc080`。整体PARTIAL，P95未接受；原R0父/wrapper/整单元FAIL，R1 NOT RUN。精确补偿清理、独立空集及同SHA关闭恢复PASS，不升级原失败。

- CI38006504899、默认部署38006504921、Amplify103与19实际工件PASS。
- R0 38008861924 / qa09-210268582a36fd89：子流程123业务/55新旧严格阶段/12无SQL负向PASS；父清理预启动batch-get-projects网络失败，两个客户DELETE409；原FAIL保留。
- 同前缀10设备/两客户/临时身份与归档精确补偿清理、独立空集/原设备证书基线PASS。无PATCH/采样重放、扩量、R1或IAM/KMS/容量调整。
- 关闭恢复38012239856：三个实际false、19代码/非API revision不变；只读快照15/70、两归档前缀零版本、12已知精确匹配Build全部SUCCEEDED。
- R0基线/采样各1物理冷409，新await queue/after分别0/2与18/22ms；R1/匹配/旧465ms解释与收益未建立。
- 独立curl6/Node12正常TLS401；原55请求另有非冷409 TCP1563ms/应用116ms，节点UNRESOLVED，不作P95接受。

[最终摘要](comparison.json)、[原失败诊断](r0/failure-diagnosis.json)、[补偿清理闭合](r0/cleanup-only-completion.json)、[单组分界观测](r0/await-observations.json)、[关闭恢复](restore/restore-completion.json)、[恢复后只读](restore/post-restoration-readonly.json)、[封存清单](manifest.json)。

归档命令、Plan及辅助程序是历史执行证据，禁止直接重放业务/StartBuild。旧失败、保守入口守卫与依赖解析失败保留；本轮新增辅助只用于既有授权范围，不作为新生产工具。下一步补父清理StartBuild前只读操作有界恢复与失败证明，人工推送新SHA后重新完整对照；不以补偿结果越过原R0 Gate。
