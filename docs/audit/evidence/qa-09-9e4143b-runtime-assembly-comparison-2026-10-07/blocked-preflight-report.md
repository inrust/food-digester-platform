# QA-09 9e4143b 运行时装配与引擎关/开目标复验

2026-10-07。同SHA发布及19实际工件 **PASS**；关/开两单元 **BLOCKED / NOT_RUN**。关闭组手动dispatch被GitHub当前身份403拒绝，未启动新前缀、业务写入或负向GET。完整QA-09/P95仍 **PARTIAL**，同pool候选继续 **DEFERRED_TARGET_DATA_REQUIRED**。

## 已核对的真实发布

固定SHA：`9e4143b5144a8aa10692927084256c225d5dd6d4`，当前远程main相同。

| 对象 | 回执 | 结果 |
|---|---|---|
| CI | [37553055804](https://github.com/inrust/food-digester-platform/actions/runs/37553055804) | SUCCESS |
| push测试部署及完整pnpm verify步骤 | [37553055773](https://github.com/inrust/food-digester-platform/actions/runs/37553055773) | SUCCESS |
| Amplify main | job 82，同完整SHA | SUCCEED |
| 19 Lambda实际ZIP | 327分段，共83,110,226字节，重组SHA256等于各Lambda CodeSha256 | PASS，0 blocker |
| 下载的部署输入artifact | qa09-deployment-inputs-37553055773-1 | push / immediate / engineCpu=true；run/attempt及workflow/resolver源码指纹绑定PASS |
| API实际配置 | test / pool1 / 512MiB / reserved12，engineCpu=true | PASS；连接预算63≤70保持 |

push默认开启部署不代替手动关闭或开启单元。输入artifact只证明部署输入；实际工件、云端配置和成功工作流另证。parallelSecrets字段缺省，默认开启依赖本SHA源码和实际工件绑定。

## 当前阻断与执行顺序

2026-10-07尝试且仅尝试一次：

```sh
gh workflow run deploy-test.yml --ref main \
  -f expected_commit=9e4143b5144a8aa10692927084256c225d5dd6d4 \
  -f engine_cpu_diagnosis=false -f rollout_phase=immediate
```

退出1：`HTTP 403: Must have admin rights to Repository`。随后只读run列表仍仅有成功push运行，未产生workflow_dispatch运行。仓库变量读取另返回403；没有修改变量，既有phase由下载的成功部署输入回执确认，手动工作流仍在AWS前严格检查phase一致性。AWS两个profile的STS均确认账号065986019555和预期SSO角色，本次阻断来自GitHub调用权限，无需调整IAM/KMS。

已请求通过具备仓库权限的GitHub会话启动 **关闭组**：Actions → Deploy test API → Run workflow，main、完整上述SHA、engine_cpu_diagnosis=false、rollout_phase=immediate，提供run链接/ID。收到运行后应重新核对当前main和SSO有效期，再下载实际artifact、核对成功部署及19 ZIP和有效false配置。只有关闭组全部业务、精确阶段、独立audit-empty及末段无漂移完成后，才启动开启组true；不得提前并行启动。

| Gate | 当前结论 |
|---|---|
| 同SHA CI/部署/Amplify/19实际ZIP | PASS |
| 关闭组手动部署 | BLOCKED：GitHub dispatch 403 |
| 关闭组12次负向GET及SQL/engine零执行 | NOT_RUN |
| 关闭组新前缀123限定业务、6+最多12 PATCH及阶段 | NOT_RUN |
| 关闭组清理、独立空集、末段绑定 | NOT_RUN；本轮未创建夹具，无本轮待清理资源 |
| 开启组部署/业务/阶段/清理 | NOT_RUN：等待关闭组完整完成 |
| on/off输入pair和运行时差异 | NOT_RUN |
| 同pool等待重叠候选 | DEFERRED_TARGET_DATA_REQUIRED，未实施 |
| 完整QA-09/P95 | PARTIAL / 未验收 |

已准备两单元安全负向GET（6匿名+6无效JWT、共12次、正常TLS验证、无重试）、精确Gateway/invocation/REPORT采集、构造/装配阶段分析及旧对照清理验证适配器。它们 **仅语法验证，尚未执行目标探针**；不能从文件存在推断业务、清理或阶段PASS。warm缺失阶段保留null；严格冷409未命中应保留NOT_OBSERVED，不重启或扩量制造冷。

## 本轮测试、证据与边界

[证据目录](evidence/qa-09-9e4143b-runtime-assembly-comparison-2026-10-07/)保留实际CI/部署步骤、下载artifact、19 ZIP哈希、实际安全配置、dispatch失败与运行列表，以及未执行的单元适配器。只读末段元数据需与初次实际ZIP绑定；原runtime-only PARTIAL不直接升级为字节验收。

- `node --import tsx --test scripts/qa09-runtime-assembly-proof.test.mjs scripts/qa09-deployment-inputs.test.mjs scripts/qa09-contract-phases.test.mjs scripts/qa09-rollout-phase.test.mjs`：40/40 PASS。
- `node --test scripts/qa09-runtime-assembly-proof.test.mjs scripts/qa09-deployment-inputs.test.mjs`：7/7 PASS。
- 两单元8份JavaScript/8份Python语法检查：PASS，仅说明解析成功。
- hosted同SHA完整验证成功；本轮无应用修改，不以本地测试代替新目标对照。

本轮没有AWS写入、身份创建、邀请发送、IAM/KMS/容量或共享资源改变，没有额外TLS探针；无需运行本轮夹具清理。设备HMAC/Active、邀请授权、网络节点归因和P95既有缺口保持，不因发布成功消除。用户原有IoT accessibility未跟踪文件不纳入本轮提交。

下一可执行任务：通过有权限的GitHub会话启动并提供关闭组运行；保持main固定在9e4143b，以[手册](../dev/QA-09-运行时装配与引擎诊断对照复验.md)顺序完成两单元及清理。无需重新授权AWS业务范围，不改变预算。任何关闭组失败先恢复本轮清理，再决定后续。
