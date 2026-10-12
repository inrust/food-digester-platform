# QA09-CLOSE-01 非Active用户闭环与证据合并复验

本手册落实2026-10-12的业务优先决定，不再启动性能R0/R1或毫秒级诊断。适用当前AWS测试账号065986019555、ap-southeast-1、fdp-test-app；禁止生产、IAM/KMS、容量修改和通知发送。设备Active、独立许可证验签、可信固件等前置不由夹具绕过。

## 先合并历史证据

运行 `node --import tsx scripts/collect-qa09-business-reconciliation.mjs <全新输出目录>/reconciliation-before.json <完整目标SHA>`。合并合法写历史嵌套账本、签名用户专项、117项语义及最近业务波次；路径和方法精确匹配，请求ID跨角色/操作冲突直接失败。每份来源保留SHA256与原提交，比较应用、共享包、契约、基础设施、锁文件和部署输入的Git对象与文件差异。

HTTP成功只证明该请求的HTTP结果，不代替持久化、设备执行、全权限矩阵或当前版本验收。源码相同也不能消除配置差异。缺口去重不得覆盖原文件或把历史NOT_RUN整体改成PASS。

## 有界目标执行

1. 核对同SHA CI、部署、19个Lambda工件、Amplify；入口必须为测试环境、pool1/512MiB/并发12、五候选false。使用现有版本采集器输出 `application-version.json` 和只读入口配置。登录余量至少10分钟、角色清理余量至少75分钟；不满足时不创建新夹具。
2. 冻结执行器源码摘要。设置 `QA09_EXPECTED_COMMIT=<完整SHA>`、`QA09_DEPLOY_RUN_ID=<部署ID>`，运行 `node --import tsx scripts/run-qa09-user-closeout-target.mjs <目录>/user-target.json <目录>/application-version.json`。目录和输出必须全新。
3. 仅创建新前缀的SUPPRESS Cognito身份，通过既有受控Worker插入INVITED数据库前置。必须使用真实Cognito subject；禁止直接播种ACTIVE或假Token。SQL按唯一ID/邮箱/Customer白名单，串行事务和语句预算；原用户/角色/scope及设备/证书摘要保持不变，重复前置直接拒绝。
4. 通过真实SRP及首次API hook推进账号ACTIVE；五角色读取/租户拒绝、角色和scope变更后新登录、同一未过期Token停用后GET/POST拒绝、审计持久化和无秘密检查。这里的账号ACTIVE不代表设备Active。
5. 两个指定自有用户分别执行375/1440宽度浏览器取消/确认停用、实际POST请求ID、API状态读回和布局检查。确认按钮使用真实“确认停用”文案。响应等待与点击的拒绝共同收束，任何一方失败均进入原清理，不允许未处理Promise终止清理。禁止请求邀请或密码通知端点；不使用API mock。
6. 最后删除本轮Cognito身份，站点/客户软删除并404读回；业务用户保留DISABLED墓碑，防止仍有效JWT落入无业务记录的bootstrap路径。核对范围外用户摘要不变。全角色、审计、浏览器和清理均通过后，才可将此专项计入版本绑定的证据。

## 未知启动与异常清理

StartBuild响应未知时原FAIL/UNKNOWN必须保留；停止后续角色准备，不重复StartBuild，不改原Plan，不把未发现Build当成未执行。先使用 `scripts/read-qa09-unknown-start.mjs` 做有界只读定位，精确匹配源、Plan、服务角色、VPC、时间窗；必要的小批只读清单也必须覆盖启动时间窗。定位和执行验收为两个Gate。

进程异常退出时，使用 `node --import tsx scripts/recover-qa09-user-closeout.mjs <原始user-target.json> <全新recovery.json>` 只做原前缀补偿。原始文件不修改；恢复器在云操作前校验原用户/站点/客户归属，创建SUPPRESS临时清理身份，业务停用、Cognito删除、实体删除及读回后删除清理身份。恢复PASS只证明清理，不修复原业务FAIL，也不解除未知Plan的禁止重启约束。原启动仍UNKNOWN时不得声明其未执行或全部未来写入已排除。

## 汇总与退出

专项成功后：`node --import tsx scripts/collect-qa09-business-reconciliation.mjs <目录>/reconciliation-after.json <完整SHA> <目录>/user-target.json`。采集器要求五角色、实际签名Token、审计、两视口、每个INVITED夹具的源/Plan/SUCCEEDED Build绑定及完整清理。失败时仅保留合并账本和原失败，不能填写五角色PASS。

该专项只补用户实体、角色/scope、停用和两项浏览器语义。邀请发送、密码通知、共享Settings、设备自然Active、OTA/Media、完整证书轮换、可靠性和八领域正式回执仍逐项闭合。完整统计性能保持REL-PERF-01未验收。QA-09总体仍需全部适用业务证据。
