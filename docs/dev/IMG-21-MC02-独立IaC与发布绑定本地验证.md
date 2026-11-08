# IMG-21 MC02 独立 IaC 与发布绑定本地验证

2026-11-09，main 基线 1c237a48。MC02 本地实现完成；未调用真实 AWS、部署、扩权、迁移目标库、启用设备或真实 G4 传图。App/真机不作为前置。

实现说明、资源/权限增量、发布/回退顺序及验收条件见 [MC02.md](../../tools/img21/MC02.md)。独立本地入口 `node --import tsx tools/img21/local-synth.ts` 只生成标明 LOCAL_FIXTURE_ONLY 的合成夹具；新只读观察器在本批仅经注入端口验证，没有运行真实 AWS CLI。

完成独立 L1 CDK 栈：A 仅 Writer（6资源）；B 增加 Verifier（共12资源），无新 VPC、网络规则、数据库、Secret、表或公开/事件入口。Writer 角色 A 无 CONTROL 写，B 需成功绑定收据及实际单 UUID；不变的 Writer ZIP/manifest/Version、两份 manifest 关联及 ZIP 实体均检查。并发各1，Writer pool1，保留连接预算；夹具余量5不等于已证明目标余量。异步设置显式零重试，资源 Retain，不代替清理动作。

旧数字模式保持精确匹配；新增显式 PUBLISHED 模式解决发布前数字编号循环。发布后以实际数字 ARN、ZIP CodeSha256、环境摘要、具体 runtime、配置、trust/inline/boundary 和 private/no-retry 状态复核，再只生成未应用的精确 Invoke 文档。Writer 和 Verifier 分别使用准备窗口与快照截止。两份既有部署控制面策略仅输出 review-only 提案，原文件未改，真实 IAM 有效权限不在本地证明范围。

快照 observedAt 固定在 Verifier manifest，截止不晚于原观察后300秒及窗口结束；打包/发布耗时不重置。发布前、读取 key 前/后、返回前拒绝过期。迟到发布不获调用材料，不能复用旧 blob 改时间；刷新 Verifier 不改 Writer 账本。SourceRef 的真实性须由后续受信 Sync 采集和候选证据绑定核验，本批合成记录不能填入目标准入。

本地工具测试120项（MC01 68项 + MC02 52项）、既有 PG/DynamoDB 回归36项、执行包回归136项通过。typecheck、lint、格式、实际源码 bundle、A/B synth、确定性 ZIP/独立解包、两次产物复算、包入口导入与默认拒绝、边界/证据/敏感信息检查结果及摘要见 [result.json](../audit/evidence/2026-11-09-device-image-MC02/result.json)。不是完整 pnpm verify、目标原生竞争、IAM 服务评估或真实发布验收。

保留两次已修复 FAIL：测试夹具的 readonly/Action 类型推断/配置记录类型；未使用测试 import 的 lint。首轮 synth 的 deprecated addDependency 警告也保留，已改为 addResourceDependency。没有通过放宽验证消除失败。详细命令、原日志和 NOT_RUN/BLOCKED 见证据目录。

目标实际角色/边界/读取权限、网络与原生连接预算、两个数字版本、真实设备/客户/证书、当前快照及新的审批窗口尚未取得；旧11/22准入不变，G4 NOT_RUN。应用 d1a7b811 的 G3 仅保留既有证据，不将新增工具自动纳入其认证；应用 strict cloudAdmission 未改。

下一可执行任务：MC03，冻结当前应用与工具候选，补齐工具独立清单/本地质量证据及候选版本绑定协议，重新评审精确部署或源等价模式，保留默认 strict 和失败历史。先完成本地可推进部分；任何真实云端准备、策略应用、部署、设备启用及 G4 均需明确范围和新窗口，不复用旧授权。
