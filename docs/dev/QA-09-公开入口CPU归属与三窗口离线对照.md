# QA-09 公开入口 CPU 归属与三窗口离线对照

本轮只建立离线归属工具，基线为应用 `12d57befe55be1e1abfd1e226c2d13cbace992dc` 已封存的自然冷 R0/R1。425ms after-queue、55ms driver-submit、37ms result-after-model 均为墙钟窗口，不能命名为 compiler CPU、数据库执行或模型完成耗时。生产源码、Admin hook、部署开关保持原样，候选默认关闭。

## 固定输入与预算

```sh
export PATH=/Users/anray/.nvm/versions/node/v24.12.0/bin:$PATH
node scripts/run-qa09-contract-cpu-runtime.mjs /tmp/qa09-public-cpu-NEW
node scripts/analyze-qa09-public-cpu-history.mjs \
  docs/audit/evidence/qa-09-12d57be-r0-r1-2026-10-10 \
  /tmp/qa09-public-cpu-history-NEW.json
```

输出必须不存在。失败保留原目录及 `failure.json`，不覆盖、不自动重试；修复后换新目录。CPU 矩阵与其他重型验证串行执行。14 个独立 Vitest 子进程顺序启动，每个45秒、pool1、采样间隔1000µs、最多45000采样/20000节点/8MiB profile；子进程输出最多4MiB。仅继承 PATH/HOME/TMPDIR/LANG/TZ/NO_COLOR，不继承 AWS、数据库或登录配置。Socket.connect 硬失败；远程数据库、HTTP、AWS Build、业务夹具均为0。既有目标预算512MiB/reserved12/pool1、静态连接63≤70不作调整；这些不是离线进程 RSS 的测量结论。

| 输入 | 开关和受控变量 | 判断目的 |
| --- | --- | --- |
| default-off | detailed/public/profile=false | 原公开观测默认关闭；离线 owner 仍沿用同一 pool1 preconnect 装配 |
| public-on | detailed/public=true；profile=false | 公开观测本身的对照 |
| profile-on | 公开观测和 Inspector 开启 | 区分采样附加成本；不能从单次差值判定性能收益 |
| account-orm | 其余同 profile-on；账号读取使用既有 ORM 分支 | 同时记录账号和后续合同成本，防止把预热误认成消失 |
| checkpoint-cpu | 原 observation-only checkpoint 处同步20ms CPU | 仅验证 after-queue 包含该观察成本；不是 compiler 注入 |
| adapter-submit-cpu | 公开 transaction.queryRaw 原调用前同步20ms | driver-submit 的公开 adapter 调用归属 |
| pg-submit-cpu | 受控 pg.query 同步入口20ms | pg-submit，且嵌套于 driver-submit |
| fields-cpu | 原受控结果 fields getter 同步20ms | pg 结算后、driver-await 内的转换成本 |
| resume-log-cpu | result-to-model 输出日志时同步20ms | 已开启 result-after-model 的恢复后日志成本 |
| pg-wait | 原 pg Promise 内30ms计时器 | pg-await 和 driver-await 的等待归属，不等同服务器耗时 |
| 四种 reject | pg / validation / update / audit 拒绝 | 原事务回滚、错误及不完整阶段不能升级完整 PASS |

每个成功输入执行同一客户端上的首次及后续共3个原事务；失败输入执行1个。合计34事务、48 checkout/release、14单 pool/单 dispose、14账号查询。保留合同 load→version update→readback→audit；audit 仅返回 id 的投影明确为离线专用。合同原生读取候选始终 false。

## 观测与所有权

只使用 Node 公开 Inspector Profiler、PrismaPg.connect/startTransaction/queryRaw、pg.query 和已有 observability 导出。adapter 的 queryRaw 装饰器同步返回原 Promise，不添加 async、then、额外读取或 PrismaPromise 消费；connect/事务入口的测试装饰器显式包含在离线装配中。复用现有观察 checkpoint，不增加强制让步。原始生产边界对象身份不变，测试通过 WeakMap 保存其公开 capture 调用前后的单调时钟括号。

三个量分别保留：墙钟、PROCESS_ALL_THREADS 的 process.cpuUsage、V8 main isolate 的叶函数位置采样计数。Profiler 的采样时间增量是采样间隔，**不是实际 CPU 时间**。Profiler start/end 必须落在本机 hrtime 调用括号±100µs内，否则拒绝；该100µs也计入每个采样的边界不确定区，不能偷偷校正时钟漂移。跨度与原日志阶段唯一匹配、共享边界墙钟在2ms及 capture 括号误差内一致；跨样本不得重叠，采样须被 profile 覆盖。

每个窗口分别输出 inside/ambiguous/outside，三者守恒。只按叶函数的公开文件位置分类；不把父子栈、嵌套阶段相加。无法识别的 Wasm/native/无 URL 样本保留 UNRESOLVED，不按私有函数名推断 compiler。profile 只保存脱敏 URL、函数名、位置、节点 ID、采样及时间；原未脱敏 profile 只留 SHA-256，不写 SQL、参数、连接串或凭据。

20ms注入必须在所属样本的公开跨度内闭合。恢复后注入说明日志输出也可能落入 result-after-model，不能将该窗口整体命名为 Prisma 模型成本。真实目标 R1 的55ms提交、37ms恢复窗口不能靠离线20ms注入解释。

## 阶段 Gate 和后续顺序

1. 离线 Gate：固定14输入、事务/错误/释放/网络计数、请求归属、时钟/跨度/采样预算与守恒、注入落点和负向校验全部通过。
2. 历史 Gate：先校验旧 manifest 及其833个内部文件，再精确提取共同 BASELINE 两条平台冷409和原55请求/组。历史外部任务清单绑定只代表原快照，新任务追加另行封存，不重写旧 manifest。
3. 决策 Gate：after-queue 内部仍无稳定 compiler 接缝，保持 `UNRESOLVED_NO_STABLE_COMPILER_SEAM`；单次本机输入、账号预热迁移和观测开销不建立因果收益。不得因此开启优化候选、增预算、部署或扩样。
4. 下一步先审阅公开入口的未归属样本与账号加合同总成本，再决定是否准备稳定的默认关闭观测接线；若未来需要目标验证，必须绑定新 SHA/19工件并沿用 R0→清理→R1→清理→关闭恢复和现有预算入口。此次未执行该目标序列。

传输分析单独使用现有 socket 事件，将 acquisition、acquisition→sent、sent→headers、headers→bodyEnd、bodyEnd→completion 分为不重叠区间。DNS/TCP/TLS 为细项不重复相加；reuse 的 null 保留未知，不改0。responseWait减应用耗时只作描述，包含网关/路由/客户端调度等未分离项，不能归因网络节点。未增加探针，第二授权网络仍缺失。
