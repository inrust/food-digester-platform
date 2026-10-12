# QA09-CLOSE-01 业务证据合并与非Active用户闭环

日期：2026-10-12。任务依据：[业务优先收口计划](../dev/QA-09-业务闭环优先收口计划.md)。本次停止性能细拆，合并历史证据，优先实跑不依赖设备Active的用户/权限/浏览器闭环。**QA-09总体PARTIAL；上线性能未验收、生产未就绪。**

## 版本与环境

受验应用为 `beaccece84ec865020aefc537af296228ec8b933`，CI [38243498847](https://github.com/inrust/food-digester-platform/actions/runs/38243498847)、部署 [38243498850](https://github.com/inrust/food-digester-platform/actions/runs/38243498850)成功。重新采集19个Lambda工件及Amplify版本，工件/部署/Git输入绑定PASS。仅对与原实包摘要及不可变S3键仍完全匹配的ZIP复用已核验字节；运行时配置、代码摘要和版本重新读取。见[版本回执](evidence/qa-09-close-01-2026-10-12/application-version.json)、[入口配置](evidence/qa-09-close-01-2026-10-12/api-entry-config.json)。

现有测试账号065986019555/ap-southeast-1/fdp-test-app，pool1、512MiB、并发12，五实验候选false。没有调整IAM/KMS、容量、共享UserPool配置或生产资源。本次新增执行器冻结源码单独绑定；本任务提交不冒充受验应用SHA或它的CI/部署结论。

## 合并、去重与兼容性

[合并前账本](evidence/qa-09-close-01-2026-10-12/reconciliation-before.json)逐项绑定原SHA、请求ID、来源摘要、原清理范围及相关Git输入。112个许可候选组合中历史HTTP成功从75补正至79：旧专项包含SuperAdmin的inviteUser、assignUserRoles、setUserScope、disableUser四项，后来账本遗漏了它们。原37项“未执行”因此去重4项，仍有33项历史从未成功，其中1项Operator退役是领域成功路径不适用；32项适用但未证明。邀请历史HTTP201不能替代本轮发送授权或邮件投递验收。

未成功的33项分布：14项真实设备/许可证状态、16项可信固件/OTA、1项Operator退役领域不适用、1项密码通知未授权、1项共享设置超出自有夹具范围。角色/scope/停用虽找到历史成功，但受影响源码已变，仍需本轮重新验证。

| 历史应用源 | 与beaccece的应用/依赖/迁移/部署输入比较 | 处理 |
| --- | --- | --- |
| 525517a、a26bd94 | 各5类根输入变化、67文件变化 | 保留历史成功；不自动转为当前验收 |
| 0abf7cf签名身份专项 | 6类根输入变化、94文件变化 | 用抑制通知的新身份补实际状态、签名Token和审计 |
| ad213fa最近业务波次 | 比较输入无变化 | 保留123检查及清理；其运行候选配置与当前默认关闭配置不同，不直接算新目标PASS |

比较范围包含apps、packages、contracts、infra、lock/workspace/package文件、Node版本、CDK启动脚本和部署workflow。历史源码相同也不证明运行配置相同；仅HTTP成功不证明持久化、完整权限或设备执行。历史100/117语义不直接转移到当前版本。

## 真实补验与异常记录

新前缀 `qa09-0d3b32843f1584db` 完成 **129/129检查、66个执行器API请求、10/10清理PASS**。五角色真实SRP登录、账号INVITED→ACTIVE hook、Operator角色往返、CustomerAdmin作用域往返、跨Customer拒绝、五个同一未过期Token停用后GET/POST均401、变更审计持久化及无凭据泄漏检查全部通过。375/1440双视口均完成取消读回ACTIVE、实际确认停用POST200及请求ID、读回DISABLED、布局和零通知请求检查。见[原始专项回执](evidence/qa-09-close-01-2026-10-12/user-target-v2.json)。66个请求不包含浏览器自身全部网络请求；浏览器实际停用请求另行绑定。

[合并后账本](evidence/qa-09-close-01-2026-10-12/reconciliation-after.json)认定7个当前版本绑定的HTTP写组合，其中角色分配、scope与停用三项包含实际状态/审计专项证明。历史累计行为从100补至102/117，剩15项历史未执行；**当前仅新增2项语义证明，未声明当前102/117或117/117验收**。5个业务用户保留DISABLED墓碑、5个Cognito身份及bootstrap删除、2站点/2客户软删除404读回，范围外用户摘要一致。

使用SUPPRESS Cognito真实subject与INVITED数据库前置：不调用邀请/密码通知接口，不SQL播种用户ACTIVE，不伪造JWT。后续实际SRP、首次API账号hook、角色/scope变更、停用与审计必须经过现有业务接口。设备Active、VERIFIED和独立许可证签名未绕过。

原前缀 `qa09-14197706b32ec5b0` 的SuperAdmin StartBuild响应超时，原FAIL/UNKNOWN保留；50条有界定位未完成，小批5条完整源/Plan/时间窗核对覆盖启动窗口但无精确匹配，因此仍UNKNOWN，禁止原Plan重启，不声称未执行。另一个Operator Build实际SUCCEEDED。浏览器执行器等待“确认”而产品实际为“确认停用”，点击失败后响应Promise未收束，进程退出。已修正真实文案并用Promise.all共同收束点击/响应拒绝，补早失败/晚拒绝测试；未知启动后停止后续用户准备并进入清理。

原始[失败快照](evidence/qa-09-close-01-2026-10-12/user-target.json)及日志不改。独立[恢复回执](evidence/qa-09-close-01-2026-10-12/user-target-recovery.json)以新SUPPRESS清理身份补偿：8项清理PASS、范围外用户摘要不变、现存业务用户DISABLED、所有本轮Cognito及站点/客户移除并读回。该PASS仅证明观测时点清理，不改原业务失败、不排除未知启动的所有未来影响。随后使用修复执行器与新前缀，原Plan未重启。

## 代码、测试与证据

- 合并器：`scripts/qa09-business-reconciliation.mjs`、`collect-qa09-business-reconciliation.mjs`及测试；精确方法/模板路径、请求去重/冲突拒绝、Git输入比较、历史/目标证明分开，拒绝缺审计、缺两视口、缺五角色/Build源绑定或清理的当前PASS。
- 执行器：`run-qa09-user-closeout-target.mjs`、`qa09-user-closeout-browser.mjs`；既有`signed-session`增加可选通知抑制前置、浏览器hook与审计读回；`qa09-ten-device-db.mjs`增加精确自有INVITED用户前置和范围外指纹，失败回滚/禁止重放。
- 恢复：`recover-qa09-user-closeout.mjs`只处理输入快照的自有用户/站点/客户，不播种、不重启Build；业务墓碑保留DISABLED，避免未过期Token落入bootstrap。外部身份和归属漂移在AWS操作前拒绝。
- 使用与停止规则：[复验手册](../dev/QA-09-非Active用户闭环与证据合并复验.md)；原证据、解码冻结源码、请求/Build关联及完整日志保存在[证据目录](evidence/qa-09-close-01-2026-10-12)。

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test scripts/*.test.mjs`（等价pnpm test:scripts） | 1316 PASS / 0 FAIL / 0跳过；包含本机回环测试 |
| `node --import tsx --test scripts/qa09-user-closeout.test.mjs` | 7 PASS；实际SQL/外部触发器回滚、禁止重复前置、未知启动不重启、浏览器Promise所有权、清理归属失败矩阵 |
| `node node_modules/eslint/bin/eslint.js <9份任务脚本>` | PASS |
| `node node_modules/prettier/bin/prettier.cjs --check <任务脚本及文档>` | PASS |
| `node scripts/check-secrets.mjs`及证据解码扫描 | PASS（含解码冻结源码） |
| `python3 docs/audit/evidence/qa-09-close-01-2026-10-12/verify.py` | PASS；历史792文件/24绑定及本轮清单校验 |
| 八份既有目标领域/前端正式回执Gate | 0/8满足，缺正式回执；保留非零退出，未伪造isolated=true或放宽完整Gate |

本地pnpm启动器曾等待无输出，已停止该本地进程并使用仓库已安装工具的Node入口完成等价检查；不影响云端进程。验证历史封存时，792个原文件及24个绑定用原审计提交6504b635中的字节核对，不重写旧封存或把已授权文档更新误报成历史证据损坏。

## Gate、剩余项与下一步

**QA09-CLOSE-01证据合并/去重/版本核对完成；CLOSE-02用户角色/scope/停用专项PASS；CLOSE-05新增2项双视口语义PASS；QA09_BUSINESS_GATE仍PARTIAL。** 本轮专项不是完整五角色合法写矩阵或全部安全验收；历史79个HTTP组合也不是当前79个组合PASS。八领域正式Gate仍0/8满足。最终独立只读已确认两前缀Cognito空集；最初五Build整批读取超时，原失败保留，仅分小批补读同5个已知ID，不重复任何写操作。独立只读身份空集/Build终态见[最终回执](evidence/qa-09-close-01-2026-10-12/final-readonly-recovered.json)。

当前未决业务：独立设备HMAC验证配置仍无，阻断自然VERIFIED→Active及其相关Command/生命周期；可信签名固件、OTA/Media/完整换证；通知发送未授权、共享Settings非自有范围；可靠性非空Replay/精确队列消费与归档/ESG、正式八领域回执与其版本适配。用户已经确认缺设备验证输入，不重复索取密钥，不借夹具伪造通过。详细性能与统计SLO保持REL-PERF-01未验收。

下一可执行工作为QA09-CLOSE-07：先离线合并已有Replay/重投/导出租约/归档证据，区分实际消费、非空输出和单纯请求成功，再仅补不依赖Active且现有权限允许的缺口；并行推进CLOSE-08正式回执映射。若实际设备验证通道到位，再执行CLOSE-03。无需重新开启性能对照。
