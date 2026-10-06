# QA-09 adapter后窗口与跨客户端TLS诊断

2026-10-06。应用基线fb6f362、仓库基线9a6750b。承接[真实冷409准备复验](QA-09-fb6f362数据库准备冷阶段目标复验-2026-10-06.md)，本轮诊断adapter后1096ms并制定[预算内优化方案](../dev/QA-09-adapter后冷窗口预算内优化方案.md)。

**本地真实Prisma/fake PG诊断及跨Node/curl真实TLS对照PASS，方案READY；AWS内CPU/编译子步骤与优化实现/发布/收益验收NOT_RUN。整体QA-09 PARTIAL，P95未验收。** 不将本机arm64计时回填Lambda，也不以公共$connect前移阶段当作性能修复。

## 数据库路径与对照

读取当前安装的Prisma7.9.1 source map及生成客户端：adapter返回后依次进入compiler JS/WASM Module/Instance/bindgen、QueryCompiler(datamodel)构造、首模型计划编译与执行；loader按provider缓存实例，后续参数化模型计划可缓存。源文件/map/生成配置哈希已保存。源码事实支持1096ms包含多类工作，不支持它等于单纯WASM Module编译或数据库连接。

新增离线诊断器：每个mode各3个全新Node24.12/arm64子进程，通过项目公开createPrismaClient和真实生成模型查询执行。仅在独立诊断进程以fake pg checkout/query返回空行，禁止实际PG连接；每次查询2次，checkout/query/release均2，前置构造及公共$connect阶段均0。WebAssembly标准构造器的计时和本地inspector CPU采样只用于离线诊断，结束后恢复，未修改生产代码或Prisma生成文件。profile只包含调用帧，无SQL/args/Secret；不启用网络调试端口。

| 对照 | 本地实测ms |
| --- | --- |
| lazy第一模型query | 55.33 / 59.35 / 62.62 |
| prepared公共$connect | 41.23 / 47.30 / 47.97 |
| prepared第一模型query | 18.20–19.28 |
| prepared准备+第一query | 59.51–67.25 |
| 第二次同形query | 0.24–0.30 |

WASM Module本机构造约2–3ms/Instance小于1ms。CPU采样按真实导出构造器名称F与compile祖先分类，构造约13.58–16.13ms、模型编译约14.96–16.67ms；采样类别互斥，包含其子调用，不是精确函数CPU耗时或AWS百分比。process CPU包含native线程，可能大于wall；本轮未模拟512MiB Lambda CPU配额。其余成本包括import/解码/调度等，不能由残差认定具体根因。

结论：提前公共$connect使first query下降，但准备+query并未下降，主要移动成本。下一方案先分出目标引擎初始化/首计划CPU，再独立并行Secret读取；仅在目标证据支持时评估单client预准备与剩余I/O重叠。保持512MiB/并发12/pool1，整体DB预算45+8+10=63≤70；不增pool或新增权限。公共API语义参见[Prisma v7连接管理](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-management)，零checkout保证仅适用于本轮实测固定adapter版本。

## TCP/TLS独立真实对照

使用同一测试API无登录GET、预期401，无写入/凭据。Node已有探针12次，峰值6；curl新增6次顺序、单并发，默认3次/强制IPv4 3次，禁用curlrc，20秒总截止、10秒连接截止、无重试/重定向/不安全TLS。环境无HTTP(S)/ALL_PROXY变量，curl正常使用现有信任库；这不证明系统代理、VPN或所有网络路径不存在/相同。响应体丢弃，只保存白名单数值、安全UUID/TLS字段，不记录IP/全头体/证书或会话密钥。

| 客户端/模式 | 实际结果 |
| --- | --- |
| Node12 | 12×401、TLS验证通过；TCP最大1630ms、TLS最大1695ms；pooled复用325/328ms |
| Node event-loop | 最大34.8ms/均值20.886ms，560样本、20ms分辨率 |
| curl默认3 | 3×401、ssl_verify_result=0；TCP312–325ms，TLS318–1769ms，总1112–2425ms |
| curl IPv4 3 | 3×401、ssl_verify_result=0；TCP312–327ms，TLS703–1495ms，总1330–2556ms；一条首字节等待1481ms |

两客户端均出现秒级TLS，IPv4对照仍出现长尾，不支持归因仅Node事件循环或仅IPv6回退；未证实丢包、某网络节点、服务端或TLS具体步骤根因。Node/curl信任库、采样时刻及可能的解析/路由不同；不凭客户端最大值比较工具性能。curl以累计计时差值计算，首字节等待含发送/网络/服务端，区别于Node request finish→headers。定义参见[curl官方手册](https://curl.se/docs/manpage.html#-w)。旧1096ms服务端窗口与这些无登录传输对照分开，不混合计算P95。

## 测试、范围和证据

```sh
node --import tsx scripts/qa09-prisma-preparation-diagnostic.mjs <dir>/prisma
node scripts/qa09-tls-diagnostic.mjs <dir>/tls-target.json
node scripts/qa09-curl-transport-diagnostic.mjs <dir>/curl-target.json
node --import tsx --test scripts/qa09-preparation-diagnostic.test.mjs
pnpm test:scripts
pnpm lint
pnpm format:check
pnpm check:secrets
pnpm check:sensitive-sinks
```

6个新进程真实Prisma对照PASS；4专项及全部582脚本测试PASS，最终lint/格式、敏感信息与Trace sink门禁均PASS并封存。全部脚本测试早于最后无效变量别名lint修复，最终字节另经4专项/6进程验证；本轮未重跑完整pnpm verify或新SHA hosted CI，不将前轮fb6f362 hosted成功回执当成新增脚本CI。

首次诊断器workspace包解析失败、首轮CPU归因未识别minified F、后续格式/构造计时起点修正及一次unused变量lint失败已保留；最终正确字节独立重跑，不归为AWS故障。初始归因中的ctor0不代表没有构造工作，最终按实际QueryCompiler.name分类。历史及中间源哈希保留，只有prisma/为最终实验回执。

变更文件：两份新诊断脚本、一份4项测试、优化方案、本报告、任务清单及[证据目录](evidence/qa-09-adapter-suffix-transport-diagnosis-2026-10-06/)。无AWS业务写入/新夹具，无需云端清理；未改应用、Prisma/依赖、IAM/KMS、容量、DNS/路由/TLS安全设置。CPU诊断fake不是数据库真实性验收；真实范围只有18次无登录GET传输。本轮方案及本地开发PASS不代表优化已部署或P95通过。

下一可执行任务：实施受控目标引擎CPU分界和Admin API独立Secret读取并行化，分别提交/测试，再按新SHA核对CI/19工件、新前缀冷阶段与清理；按方案Gate比较端到端，之后再决定是否启用预准备/I/O重叠。另一个授权主机/网络或运维网络证据尚未提供，跨网络根因诊断NO_RECEIPT。
