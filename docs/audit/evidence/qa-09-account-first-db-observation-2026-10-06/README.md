# 账号状态与首次数据库观测本地证据

local-gate.json为本次本地源哈希与验证汇总；目标新SHA CI/部署/19工件/冷409为NOT RUN，整体QA-09 PARTIAL。sourceCommit在人工推送后按实际完整Git SHA及目标回执绑定，本目录不把baselineHead当本次部署SHA。

- sources.json：12个代码/测试/工具文件的最终字节哈希；Git提交后再比对Git blob。
- verify-initial-sandbox-fail.log：首次完整验证因localhost listen EPERM阻断，保留失败。
- verify-final.log：获准本地监听后的完整pnpm verify。
- focused-final.log：53项相关Vitest，其中真实Prisma引擎和pg Pool.query使用受控driver client；不建立RDS连接。
- phase-gate-tests.log：20项关联/阶段Gate测试，含新增嵌套/冷409及分析器差值/顶层计数断言。
- old-receipt-negative.log：旧9b60754目标回执缺新阶段被新Gate拒绝，未生成成功回执。
- old-compatible-proof.json、old-compatible.log：历史默认Gate兼容检查PASS25，非本次新阶段目标验收。
- local-qa*.json：七项本地回执原始字节；均为本地模型/HTTP夹具/浏览器，AWS目标未执行。

完整验证的应用测试1371项之后补充了真实Prisma/pg桥接测试，并在最终53项专项、数据库typecheck及lint/format增量检查中验证；不把该新增测试冒充为此前完整1371项之一。阶段脚本的最终增量20项另行复验。

manifest.json封存文件路径、大小和SHA256；原始JSON不重排。待新SHA部署后必须使用新prefix、完整19 ZIP核对、强制account/cold409 Gate，并执行本轮资源清理与AWS内audit-empty。
