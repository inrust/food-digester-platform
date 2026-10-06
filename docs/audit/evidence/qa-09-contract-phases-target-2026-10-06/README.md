# 9b60754 同 SHA 合同阶段目标回执

入口为 target-summary.json（限定 PASS，整体 QA-09 PARTIAL）。manifest.json 封存目录原始字节；不对目标回执 JSON 重排格式。

- application-version.json：测试前完整19个ZIP、327分段实际SHA256。
- runtime-final.json：复验尾段只读元数据，原始Gate PARTIAL；runtime-final-binding.json 与实际ZIP证明配对，无漂移。
- contract-race.json：81项检查PASS；fixtures.json、domain-cleanup.json、gate.json：父夹具与域清理PASS。
- database-empty-audit.json：补充独立AWS内只读零残留及既有设备/证书指纹核验；全部受控数据库Build为SUCCEEDED。
- request-correlation.json、audit-get-correlation.json：绑定最终child字节，6/19逐请求关联；phase-proof.json PASS25自身不证明清理/P95，清理由target-summary独立绑定。
- phase-latency-analysis.json：analyze-latency.py 从关联回执生成，嵌套事务阶段不重复计入总和。
- api-complete-precleanup.json及*-precleanup.json/log：中途诊断快照，不能作为最终清理证据。
- target-verify-initial-failed.log：封存辅助检查最初误把设备删除前数组视为删除后空集，保留失败。verify-target.mjs 已按删除计数和独立audit-empty复核，target-verify-final.log PASS。

所有执行源快照及受控Build准备回执保留，manifest包含源和回执的路径/大小/SHA256。CI/Deploy/前端版本记录同9b60754；本次只新增文档和证据，不更改运行时代码。慢409和历史缺失请求仍保留风险，19次审计GET成功不等于历史超时已根治。
