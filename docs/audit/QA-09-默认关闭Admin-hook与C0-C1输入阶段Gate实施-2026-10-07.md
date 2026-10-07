# QA-09 默认关闭 Admin hook 与 C0/C1 输入、阶段 Gate 实施

2026-10-07。基线6b6d67b07434c57ca0bcbde9306b409fc239e3d4。本轮完成默认关闭的运行时接线、真实账号状态组合及C0/C1可重复输入/严格阶段Gate；没有执行AWS、GitHub dispatch或远程推送。

## 实现与控制

| 控制 | 变更/证据 | 本轮结论 |
| --- | --- | --- |
| 默认关闭/唯一API | runtime env、Infra context和栈构造三处guard；普通push固定false，只有手动C1允许true | PASS |
| 固定预算/引擎模式 | C0/C1均engine=true，仅切换preconnect，保持pool1/512MiB/并发12及63静态预算 | OFFLINE PASS，实际峰值NOT_RUN |
| 唯一client及认证顺序 | Lambda选择单factory；真实PrismaPg/受控driver的实际Router+hook；C1负JWT初始化zero checkout | PASS |
| 账号不缓存 | 新公共hook先等待准备，再每次执行原用户查询；ACTIVE后DISABLED仍拒绝 | PASS |
| 激活与竞争 | PGlite执行条件更新、INVITED并发停用拒绝、重复请求审计一次 | PASS |
| 原子回滚 | 数据库trigger强制激活审计写失败，用户仍INVITED且审计零条 | PASS |
| 准备失败/未完成 | C1原checkout错误保留、账号查询零次；屏障释放前无账号查询 | PASS |
| 缺失账号 | 保持现有无写入语义，不新增bootstrap SQL | PASS |
| 输入可比 | SHA/phase/hash/context绑定、不同run、双engine=true/C0false/C1true；漂移负例 | PASS |
| 阶段认领 | 双路成功后账号查询，预连接与业务checkout分离；C0拒绝预连接 | PASS |
| 负阶段 | 缺失/重复/失败/外身份/时间/耗时/边界/抢跑/越界及父Gate缺engine/runtime | PASS |
| 源码和分析 | 新proof哈希、父/业务runtime/controller/hook绑定；warm=null、不相加嵌套阶段 | PASS |
| 目标部署/连接/P95 | 没有目标候选新部署或业务运行 | NOT_RUN |

状态语义采用真实PGlite数据库及真实迁移，预连接端口受控模拟；另有真实生成Prisma/adapter的受控pg driver顺序证明。两个离线层均不能冒充AWS网络、实测峰值或优化收益。历史6b6d67b报告/证据保留原样。

变更文件包括：Admin hook/diagnostic/lambda-entry、database factory说明、账号组合/认证/runtime测试、Infra config/stack/预算配置测试、deploy-test工作流、部署输入/rollout resolver、阶段checker/proof/analyzer及负测试、两份业务执行器源码绑定、任务清单/方案/手册和本轮证据。

## 验证与 Gate

专项命令见[复验手册](../dev/QA-09-Admin-hook与C0-C1复验手册.md)：应用/数据库5文件34项、最终脚本54项PASS，cloud-api类型检查PASS；CDK专项2文件5项PASS（随后增加配置guard负例由完整verify验证）。完整 `pnpm verify` exit0：1418应用/基础库、302契约、607脚本、主浏览器36与QA-05专项108执行，七份本地Gate均PASS。完整verify之后仅补factory说明注释和proof非空身份保护，最终34专项/54脚本及全仓lint、增量format通过；不把607写成最终新增用例总数。归档日志只去行尾空白/多余EOF空行，原始哈希和归档哈希均保留。完整verify与最终增量证据见[证据目录](evidence/qa-09-admin-hook-c0-c1-2026-10-07/)。

Gate：默认关闭接线、真实账号组合、C0/C1输入与阶段验证离线PASS；同SHA部署/19工件/目标C0/C1、AWS连接峰值、收益NOT_RUN；整体QA-09/P95仍PARTIAL。网络超时、实际握手及准备连接复用没有新实测证据；独立验签、邀请发送、第二网络等既有边界不变。

下一可执行任务：人工GitHub Desktop推送本地提交后，核对同SHA CI/默认关闭部署、19工件及实际flag/预算，先执行C0的新前缀限定业务/自然冷关联和清理；C0清理闭合后再决定C1，不自动启动两组。Git提交SHA由完成消息提供，避免文档自引用；既有两项未跟踪可访问性材料不纳入提交。
