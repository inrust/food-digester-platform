# QA-09 2026-10-10 本地合同 await 分界与独立传输证据

主证据：matrix-final/matrix.json，primary-matrix-entry.json绑定已完成的verify-scoped-host.json；最终源码哈希与每例receipt/log/command/exit均保留。matrix/是早期与校验启动短暂重叠、默认服务路径尚未最终整理的过程矩阵，仅用于保留控制/所有权事实，不作为最终源码或性能收益证据。

verify-initial.log是原pnpm verify受用户未跟踪build阻断；verify-scoped.*是临时ignore位置错误的过程失败；verify-scoped-final.*是沙箱3项回环监听EPERM；verify-scoped-host.*是仅排除build lint/format后完整链通过。后两版保留了未启用的prettierIgnore元数据，实际命令以commands中的默认ignore及!build/**为准。原始日志包含空白，未重写。

聚焦初期断言失败、修复后62项、36项proof、最终全链和11例矩阵一并保留。七本地Gate中的AWS NOT RUN仅指本地执行器，历史24d50d6真实目标证据未改，history-integrity验证752+404文件。

curl6+Node12无登录正常TLS目标GET仅诊断传输，不保存正文/凭据，不进行业务写入。候选默认false/仅离线，无新的目标夹具、部署或IAM/KMS/容量变更。新SHA目标分界NOT_RUN，整体QA-09/P95 PARTIAL；详细解释见上层实施记录和复验手册。
