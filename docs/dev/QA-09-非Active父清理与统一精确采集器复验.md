# QA-09 非Active父清理与统一精确采集器复验

依据：[清理观测与已启动Build恢复](QA-09-清理逐操作观测与已启动Build受控恢复复验.md)、[ORM/pg细分复验](QA-09-ORM提交与pg结算默认关闭观测复验.md)、[本轮实施记录](../audit/QA-09-非Active父清理与统一精确采集器实施记录-2026-10-09.md)。本轮只修改验收执行器；应用、SQL、IAM/KMS、容量、开关默认值和严格5ms门禁均不变。

## 父清理及原始整单元准入

父执行器源快照新增 `scripts/qa09-nonactive-cleanup.mjs`，继续覆盖每个child执行源码。启动任何数据库Build前持久保存action、receipt与RUNNING账本；成功后保存准确Build ID/PASS，失败保存安全错误/FAIL。未知启动结果不得重放SQL、重复StartBuild或猜测共享项目最近ID；沿用原prepared/started字节及唯一Build只读恢复边界。

父 `cleanupOperations` 逐步覆盖数据库observe/cleanup/原设备证书基线、身份刷新、两客户scope/delete/absence和Cognito注销/delete/get。SignOut失败继续删除及核验，原整体仍FAIL。GetUser仅UserNotFoundException可作为身份不存在证明；原SDK失败行保留expectedOutcome。所有错误使用统一安全白名单，不保存SDK输入、错误正文、密码、Token或SQL。

`validateNonActiveParentCleanup` 要求原父PASS、所有汇总PASS、操作连续且完整、每个数据库账本PASS且有准确ID、两条本轮客户的全部操作及身份删除/不存在证明。原wrapper必须包含 `parentCleanupObservation.gate=PASS`；独立恢复不能替代原始整单元PASS。归档清理仍先按已有精确所有权规则尝试，再检查新增父观测门禁，避免因观测失败跳过原本可执行的自有归档清理。

新目标的closure辅助脚本应接受新增的数据库账本 `gate=PASS` 并验证它，不可沿用历史“账本不得有gate字段”断言。源快照必须覆盖新模块及所有child依赖；核验旧f7封存不能用新源码重写旧wrapper FAIL。

## 单入口普通/精确日志读取

普通与精确模式均运行 `scripts/collect-qa09-contract-correlation.py`，共用同一字段投影；禁止复制历史helper中的另一套字段白名单。保留ownership的detailEnabled/pgQueries/pgSettlements、PG_DISPATCH/PG_SETTLED及合法CPU字段；未知字段、布尔CPU等不持久化。

```sh
# CHILD.json 必须是本轮原始业务回执；每次使用不存在的新输出路径。
python3 scripts/collect-qa09-contract-correlation.py CHILD.json BASELINE.json
python3 scripts/collect-qa09-contract-correlation.py CHILD.json BASELINE-EXACT.json --exact-from BASELINE.json
python3 scripts/collect-qa09-contract-correlation.py CHILD.json SAMPLING.json --cold-sampling
python3 scripts/collect-qa09-contract-correlation.py CHILD.json SAMPLING-EXACT.json --cold-sampling --exact-from SAMPLING.json
python3 scripts/collect-qa09-contract-correlation.py CHILD.json AUDIT.json --audit-get
python3 scripts/collect-qa09-contract-correlation.py CHILD.json AUDIT-EXACT.json --audit-get --exact-from AUDIT.json
# 独立采样审计同理同时添加 --cold-sampling --audit-get。
```

精确模式先绑定原业务回执SHA256/前缀/commit和prior回执字节，验证唯一Gateway记录、方法、状态、扩展ID（业务回执提供时）及请求时间窗口。仅接受1–19个唯一UUID invocation，过滤表达式≤1024字符；继续读取新鲜Gateway日志，只有Lambda读取使用这些已绑定ID过滤。沿用每组最多20页及每次45秒读取上限，不新增业务请求，不扩大采样或修改旧回执。输出路径已存在时，在任何AWS读取之前拒绝。

原PARTIAL/失败回执必须保留；精确读取另存新文件并记录prior哈希。它只补同一批请求日志可见性，不生成新业务PASS，不提升原失败整单元，也不能用旧时间窗口日志假称当前应用行为。

## 新SHA顺序与预算

1. 本地验证并提交，人工通过GitHub Desktop推送。核对新完整SHA的CI、默认关闭部署、Amplify和19个实际工件；e3da42c发布成功仅证明基线版本，不能替代新增代码版本。
2. 用新证据目录和新前缀，先核对可续期SSO、既有登录/角色清理余量、唯一受控Build通道及原设备/证书基线。重新生成新SHA固定对照输入，不混用旧SHA R0。
3. R0：engine=true、preconnect=true、account=false、detail=true、immediate。6个基线PATCH/19个审计GET、最多12个独立采样PATCH/18个审计GET及12认证负向。原业务、严格阶段、父/子清理、GlobalSignOut、独立数据库空集、归档零版本、原设备证书基线和19配置必须全部闭合才进入R1。
4. R1新前缀，仅改account=true；同SHA、同观测、同预算。完成相同业务/严格阶段和全部清理。共同BASELINE自然冷优先，缺共同基线才检查共同独立采样；缺冷保留NOT_OBSERVED，不造冷、补样或混组。
5. 同SHA关闭恢复：engine=true，preconnect/account/detail=false、immediate。核对19代码及非API revision不变、实际开关关闭、只读连接预算、精确本轮空集、归档零版本及全部已启动Build终态。
6. 任何原始整单元/严格Gate失败，停止R1，按原前缀精确补偿及关闭恢复；原FAIL保留，不能通过改写回执获得准入。

预算保持API512MiB/arm64/node24/reserved12、pool1、静态63/可用70、业务并发≤6。分钟Maximum不证明未采样瞬时峰值。无IAM/KMS/容量调整或邀请发送。独立设备验签/自然Active、候选收益/P95和TCP/TLS具体节点归因维持原证据边界。
