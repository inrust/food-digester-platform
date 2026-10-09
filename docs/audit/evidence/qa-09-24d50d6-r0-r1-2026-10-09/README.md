# QA-09 24d50d6 新前缀 R0/R1 目标复验

完整SHA：`24d50d6c3a9000c629d8255f78ea8d57a9d5b3f7`。原始R0/R1业务、严格阶段、父/子清理、独立空集及同SHA关闭恢复均PASS；整体QA-09/P95仍PARTIAL，收益NOT_ESTABLISHED。

- R0：37910881433，qa09-afbeb4e37059fa8c，123业务/55阶段/12无SQL负向，父13/子21操作，基线1/采样2自然冷409，分钟Maximum16/70。
- R1：37916405808，qa09-e3b5ecda6e6d2fb5，同上业务/阶段/负向/清理，基线1/采样1自然冷409，分钟Maximum16/70。
- 关闭恢复：37922090335；三个候选实际false、engine=true，19代码及非API revision不变；只读连接快照15/70、空集PASS，两组4归档前缀零版本，21已知/精确匹配Build终态PASS。
- 共同BASELINE自然冷匹配INPUT_COMPATIBLE；详细ORM/pg分析OBSERVATIONS_ONLY。候选收益/纯compiler或server归因未建立。

原容量启动响应超时仍UNKNOWN；用户授权仅一次独立capacity-readonly入口，原Plan未重启。普通/精确采集统一canonical入口，输出保留原字节；本轮无业务重放、造冷或额外采样，无IAM/KMS/容量调整。初次关闭恢复的GitHub TCP失败发生在dispatch前只读核验，保留失败日志后唯一派发。旧f7失败回执不升级。

[比较回执](comparison.json)、[细分观测](contract-load-observations.json)、[R0闭合](r0/unit-completion.json)、[R1闭合](r1/unit-completion.json)、[关闭恢复](restore/restore-completion.json)、[恢复后只读](restore/post-restoration-readonly.json)。归档命令与Plan均为历史执行证据，禁止重放业务或StartBuild。
