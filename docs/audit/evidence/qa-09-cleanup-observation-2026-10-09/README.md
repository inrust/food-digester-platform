# QA-09 清理观测与已启动Build恢复

本目录记录本地实现验证及上一轮唯一Build的真实只读恢复。新SHA hosted部署/19工件和新前缀完整R0/R1：NOT_RUN，等待人工推送。本轮不新增业务夹具、不启动云端Build、不调整AWS权限。

- `verify.log`：首次完整验证失败（新增身份测试漏导入2项及沙箱回环listen EPERM 3项），原样保留。
- `targeted-tests.log`：身份矩阵新增时的漏导入失败；`targeted-tests-fixed.log`修正后16项PASS；`targeted-tests-final.log`增加启动响应丢失边界后17项PASS。
- `verify-fixed.log`：获准本机回环后完整验证；最终启动不确定分支由`final-script-tests.log`全量脚本及最终lint/format补核。具体结果以summary为准。
- `existing-build-readonly-recovery.json`、`existing-build-readonly-final.json`：只读恢复同一个历史Build；后者依赖源字节与最终工作树绑定。未覆盖任何历史FAIL/RUNNING回执，也不构成新SHA业务验收。
- `target-plan.json`：待推送的对照准备计划，sourceCommit=null / targetGate=NOT_RUN；不是发布或验收回执。
- `manifest.json`：本目录及实现源文件字节绑定，详细Gate边界见summary。
