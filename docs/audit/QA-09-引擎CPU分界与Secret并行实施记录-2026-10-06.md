# QA-09 引擎CPU分界与Secret并行实施记录

2026-10-06。承接[预算内方案](../dev/QA-09-adapter后冷窗口预算内优化方案.md)，本轮实施第1/2步，复验流程见[新版本手册](../dev/QA-09-引擎CPU分界与Secret并行目标复验.md)。仓库起点04075e8，应用目标仍待新SHA发布；不以fb6f362的旧CI/19工件证明本轮实现。CPU分界独立提交893d791，Secret优化及完整证据为随后独立本地提交。

## 实现与语义

- Admin API仅测试环境/pool1可启用CPU诊断，JWT验签及JSON解析后、账号模型查询前执行一次公共$connect，复用原client、single flight，成功缓存、失败保持原异常并允许后续请求再准备。匿名/坏JWT不调用准备或业务SQL；每个有效请求仍检查业务账号状态，不缓存DISABLED/INVITED。没有初始化期引擎预准备、查询预热、私有Prisma patch或多pool。
- db-engine-prepare/db-engine-after-adapter以OPERATION_SETTLED结束，后续模型db-client-prepare仍以DRIVER_DISPATCH结束。engine、suffix及账号模型查询记录安全user/system微秒整数，明确PROCESS_ALL_THREADS；包含native/后台和可能重叠工作，不是纯编译或JS线程CPU。
- Admin initialize先校验全部必需配置/pool/开关，再并行读取原DB URL与License Secret。两个promise全部settle，DB错误优先、License错误次之，保留原错误；只有双方成功才构造client和handler。单飞初始化成功复用一个handler/client，失败不发布半成品，原请求不重试业务写入。顺序回退代码开关保留，云端优先回退对应独立提交。
- CDK只向唯一API下发诊断开关，默认关闭/test容量前置；测试工作流capacity/immediate阶段默认开启，显式false可关闭。512MiB/并发12/pool1、63≤70预算不变。Collector仅接收白名单整数CPU与固定scope；checker/analyzer的--engine-cpu明确验证新阶段所有权，--client-preparation仍必选；原lazy模式严格门禁保持。

## 验证与证据

```sh
pnpm exec vitest run apps/cloud-api/test/admin-engine-diagnostic.test.ts apps/cloud-api/test/admin-lambda-composition.test.ts packages/database/test/client-preparation.test.ts packages/observability/test/data-path.test.ts infra/test/qa09-performance.test.ts
node --import tsx --test scripts/qa09-contract-phases.test.mjs scripts/qa09-rollout-phase.test.mjs scripts/qa09-cold409-correlation.test.mjs
pnpm exec vitest run apps/cloud-api/test/admin-runtime-initialization.test.ts apps/cloud-api/test/admin-runtime-secrets.test.ts apps/cloud-api/test/admin-engine-diagnostic.test.ts
pnpm verify
```

CPU/认证/真实Prisma fake PG/CDK专项30项PASS，阶段/rollout/精确关联负向34项PASS；实际Lambda初始化与并行失败专项10项PASS。首轮新增测试夹具因不支持的assert.isRejected及fake pg未实现callback产生失败/超时，CDK曾因新增export未重建dist失败，已修复夹具并先构建后重跑；原失败日志保留，不归为AWS故障。

完整pnpm verify退出0：173个测试文件/1388项单元集成、302项契约、584项脚本通过；36项基础浏览器测试、QA-02设备契约及QA-03至QA-08本地套件均PASS；lint/format/typecheck/OpenAPI/build/边界/迁移/证据/敏感与交付门禁通过。完整日志与最终源哈希见[证据](evidence/qa-09-engine-cpu-parallel-secrets-2026-10-06/)。新增代码在工作树冻结后验证，本地套件自动标记baselineCommit=893d791，代表运行时Git起点；最终源码快照/manifest绑定本轮工作树实际字节，不把该字段误认为Secret并行已包含于893d791。

变更文件覆盖：cloud-api runtime入口/engine diagnostic/runtime secrets及user account hook；database preparation/index；observability data-path；infra config/唯一API接线、测试部署workflow；rollout、collector、checker/analyzer及专项测试；任务清单、新复验手册、本报告和证据。未修改依赖/Prisma生成文件、其他DB worker调用、IAM/KMS、容量、DNS/路由或TLS校验。

## Gate、风险与下一步

本地实现验证以封存回执为准。新SHA hosted CI/Deploy/Amplify、19实际ZIP、真实CPU/Secret重叠及新前缀清理尚无回执，目标复验NOT_RUN；QA-09仍PARTIAL、P95未验收。本轮未创建AWS夹具/身份或执行云端写入，无本轮云端清理项。

风险：公共$connect主要前移成本，CPU计数也包含后台线程，首模型CPU仍含driver处理；并行Secret实际收益需目标端到端证明。诊断与并行共同上线的前后样本不能单独归因到并行Secret。未命中物理冷409仍COLD_CONFLICT_REQUIRED，不扩大预算造冷。TCP/TLS跨客户端长尾根因仍未确定，继续按独立探针/另一授权网络证据诊断，不与服务端阶段混算。

下一可执行任务：人工推送最终SHA后核对同SHA CI/部署/19工件、唯一API诊断与容量配置；再执行新前缀原三轮与有界冷409采样、CPU/Secret阶段关联、全部自有夹具清理/独立空集及尾段版本无漂移。使用新手册--engine-cpu门禁，不伪造历史阶段。仓库[AGENTS.md](../../AGENTS.md)明确：“所有远程推送必须由人工通过 GitHub Desktop 执行”；因此本轮无法自行推送启动新SHA部署。
