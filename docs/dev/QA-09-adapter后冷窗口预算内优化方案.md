# QA-09 adapter后冷窗口预算内优化方案

2026-10-06。应用基线fb6f362，仓库基线9a6750b；依据[真实冷阶段复验](../audit/QA-09-fb6f362数据库准备冷阶段目标复验-2026-10-06.md)及[本轮诊断](../audit/QA-09-adapter后窗口与跨客户端TLS诊断-2026-10-06.md)。方案READY，生产代码实施/新SHA部署/目标优化验收NOT_RUN。

截至本轮后续实施，第1/2步已落地本地代码，记录见[实施记录](../audit/QA-09-引擎CPU分界与Secret并行实施记录-2026-10-06.md)及[目标复验手册](QA-09-引擎CPU分界与Secret并行目标复验.md)；新SHA发布/真实收益仍待回执。第3步保持未实施。上述NOT_RUN为方案签发时状态，不替代后续实施记录。

## 判断与预算

目标account query→driver1101ms，prepare1099、adapter后1096ms。安装的Prisma 7.9.1实际顺序为adapter返回→加载编译器JS/解码并构造WASM Module→Instance/bindgen启动→QueryCompiler(datamodel)构造→首模型查询编译→执行计划/driver。loader按provider缓存实例；同client重复模型查询可命中参数化计划缓存。不能把1096ms单独归因为WASM Module编译或数据库连接。

本地arm64/Node24.12六新进程、真实生成客户端和禁止真实PG连接的驱动对照：lazy首query55–63ms；prepared的公共$connect41–48ms、首query18–19ms，总59–67ms；warm约0.24–0.30ms。WASM Module约2–3ms、Instance小于1ms，采样归因的QueryCompiler构造约14–16ms、模型编译约15–17ms。数值包含profiler开销，process CPU包含native线程，不能映射成AWS512MiB的阶段百分比或预测收益。

| 项 | 必须保持 |
| --- | --- |
| API | 512MiB、reservedConcurrency12、pool1，单个长驻Prisma实例 |
| 18个DB Lambda总体 | 现有infra/src/database-capacity.ts immediate=true：稳态45+运维8+空闲/轮换重叠10=63≤普通槽位70，余量7 |
| 业务复验 | 新前缀；基线6 PATCH、两批各最多6并发/采样12 PATCH，严格冷证明独立计数 |
| 权限/资源 | 不新增IAM/KMS、RDS Proxy、预置并发或额外pool，不重启共享服务 |
| 用户语义 | JWT验签/角色/客户归属、账号状态hook、版本冲突和审计原语义；无预读业务SQL/虚拟查询/写入重试 |

公共$connect是Prisma提供的接口，但其连接语义取决于当前adapter。本地精确版本证明PrismaPg工厂准备时checkout/query均0；不能据此给任意未来adapter或升级版本保证零连接。[Prisma v7连接管理](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-management)。

## 实施顺序

1. **先补目标CPU与引擎准备分界。** 在签名JWT验证成功、账号查询前设置受测试配置约束的诊断分支，以公共$connect的wall/process CPU和首账户模型query现有计时分开引擎初始化与首次模型计划成本。一次请求只运行一次，不调用业务SQL预热，不导入/猴补Prisma私有API或修改生成文件。记录安全阶段/整数指标，不输出profile全文、SQL/args/Schema/Secret。这一分支用于诊断，预期主要移动成本，不能直接认定优化成功。Gate必须同时验证平台冷REPORT、account hook总量和客户端总量。
2. **首选独立Secret读取并行化。** 仅修改Admin API initialize，验证全部配置后并行开始DB URL与License signing key读取；保持相同Secret引用/权限及内存缓存。等待所有启动promise结算，按明确顺序处理失败，不产生未处理reject，不记录值，失败时不暴露半初始化handler。先保留原lazy Prisma，单独比较runtime-initialize与端到端冷窗口。收益需实测，不将963ms总初始化假定为两个可完全重叠的网络等待。
3. **再评估有限引擎预准备与剩余I/O重叠。** 若目标CPU/阶段与第2步证据支持，在Admin API局部、默认关闭的配置开关后启动单client公共$connect，与仍未完成的独立初始化I/O协作；不改共享createPrismaClient工厂，不影响其他17个DB函数。只在handler发布前准备一次，防止每请求/重试/新client重复准备。失败时结算全部promise、disconnect已建立的适配器并保留原错误，不能先返回可用handler。明确额外CPU也可能发生在cold401，必须做未认证负向对照；若仅移走account阶段或cold401回归，则不启用。

第3步需要显式变更阶段所有权：引擎准备/adapter计时可能属于runtime-initialize，后续account query仅含首计划编译。新Gate需按开关和唯一engine-ready成功事件证明ready早于account hook，并验证adapter位于runtime准备范围、checkout仍在真正查询范围。不能直接关闭--client-preparation或放宽旧冷Gate；开关关闭时仍执行原严格lazy嵌套门禁。warm缺阶段保持null，物理coldStart/REPORT不能被客户端ready状态替代。

不推荐直接增内存/并发、启用预置并发、拆多个Prisma client/pool、升级依赖或直接查询compiler私有成员。也不以SELECT 1、虚构账号查询预热或绕过账号状态hook换取阶段数字改善。公共$connect前移本地总成本并未减少，单独采用它不是已证实的修复。

## 验证、发布与回退

每步单独提交与开关，保留旧失败回执。实施后必须完整pnpm verify、同SHA CI/Deploy/Amplify与19实际ZIP；人工GitHub Desktop推送。先只读核对预算和普通槽位/运行版本，再使用新前缀。原三轮、采样、CPU诊断和TCP/TLS回执分开；未命中冷409保留COLD_CONFLICT_REQUIRED，不扩采样或重启共享Lambda制造冷态。

验证真实模型、batch/interactive事务、懒PrismaPromise、disconnect/reconnect、query/准备失败时原错误及release所有权；Secret任一失败和并行未处理reject、匿名/坏JWT不会进行checkout/SQL、五角色与账号DISABLED/INVITED语义、合同条件PATCH/审计与清理。新增计时只存安全枚举和数值。重复执行不能新建pool；并行失败的SQL写入不得重发。

选择候选以独立匹配的客户端/Gateway/REPORT/顶层应用总耗时、CPU及内存为准，不能以account prepare接近0作为PASS。首个冷样本仅是诊断/回归证明；SLO/P95仍需其原定足量场景。若Secret并行或预准备出现端到端回归、401回归、槽位超预算、阶段漂移或清理失败，关闭对应开关/回退对应独立代码提交，保持pool1/并发12/512MiB和旧lazy路径。

## 传输独立路径

本轮Node12 GET和curl6 GET均正常证书验证/401；两客户端都出现秒级TLS，curl强制IPv4也未消除。本轮既不改变TLS版本、证书校验、DNS/IP、代理/VPN或系统路由，也不把代理环境变量缺失当成系统代理/VPN不存在。连接复用可避开新握手，但不会解决首次连接；Node执行器已有max6 keep-alive，不能仅扩大socket数。

下一传输对照优先在另一已有授权执行主机/网络重复同样12+6请求及工具版本，或由网络运维提供同窗口的脱敏重传/握手/路由证据；本轮未取得这些回执，不指定某网络节点根因。禁止日志记录原IP、Proxy URL/凭据、证书/会话密钥、全响应头体。curl timing为累计值，脚本以差值划分DNS/TCP/TLS/首字节；首字节等待包含发送/网络/服务端，不能与Node finish→headers简单等同。[curl官方计时定义](https://curl.se/docs/manpage.html#-w)。
