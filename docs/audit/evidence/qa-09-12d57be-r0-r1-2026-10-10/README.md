# QA-09 12d57be R0/R1 目标证据

应用源 `12d57befe55be1e1abfd1e226c2d13cbace992dc`。R0→原清理→R1→原清理→四开关关闭恢复已完成；恢复运行38057515541。请求范围及原清理/空集/预算PASS，整体QA-09/P95仍PARTIAL。

[审计报告](../../QA-09-12d57be合同公开接缝R0-R1目标复验-2026-10-10.md)记录五个同SHA运行、19工件、两个新前缀、自然冷分界、预算和未决风险。[比较](comparison.json)为PARTIAL；[公开分段](contract-load-observations.json)为OBSERVATIONS_ONLY，不能证明因果收益或模型成本后移。

R0/R1各123业务、55关联、12负向通过，原父子清理和独立空集PASS；共同BASELINE各1条平台冷409。恢复后preconnect/account/detail/public=false、engine=true、19代码不变、18非API revision不变，四归档域空集，21精确Plan Build终态。R0/R1分钟连接最大17/16≤70，最终快照15≤70，不证明连续瞬时峰值。

原R0和恢复等待读取FAIL，以及八份日志原读取PARTIAL全部保留；精确读取未新派发或重放业务。[读取溯源](log-read-provenance.json)、[恢复等待读取](restore-read-provenance.json)、[工件与R0读取](additional-proofs.json)可独立检查。原启动前只读瞬态恢复本轮NOT_TRIGGERED；历史UNKNOWN证据不变。

`manifest.json`封存全部其他文件及最终报告/任务清单字节；`completion.json`仅证明请求序列完成。所有存在输出目录的执行器禁止重放。只读重复封存检查：

```sh
python3 docs/audit/evidence/qa-09-12d57be-r0-r1-2026-10-10/check-seal.py
```

无IAM/KMS/容量调整、额外网络探针、强制造冷或邀请发送。after-queue compiler归因、传输节点归因及P95仍未决；HMAC/自然Active/邀请发送NOT RUN。
