# IMG-21 云端接口 Gate 与目标准入材料

2026-11-08。用户确认沿用新加坡 `fdp-test-app`，设备与身份待准备。本批从干净 main `afae9c0a` 继续；应用候选仍为 `d1a7b81196d60ec320e760da3d18de403563fc12`，G3 证据提交为 `1b1b879ffcf34be7cebd6fe87b8301ae5bd21356`。

**接口 Gate 不等待第三方 App/真机通过。** 用受控模拟设备在真实云端完成实时图片帧和 EVENT/ALARM 图片留档闭环，就可以给 G4=PASS_CLOUD_INTERFACES。当前离线准备通过，但目标没有执行，G4=NOT_RUN。

## 通过条件和范围

| 核心用例 | 真实目标证据 |
|---|---|
| CF01 实时帧 | 五个预览接口经正常公开入口调用，租约/ACTIVE/current streamId、帧上传200、latest READY、Base64解码的JPEG字节与Hash一致、释放204 |
| CF02 EVENT 图片 | 原事件消息ID关联triggerRef，S3 PUT原图，MQTT media登记，同申报409 MEDIA_ALREADY_REGISTERED确认业务完成，事件查询AVAILABLE，同mediaId下载Hash一致 |
| CF03 ALARM 图片 | 同CF02，原触发必须是ACTIVE告警的消息ID；告警详情AVAILABLE，下载Hash一致，不能引用CLEARED消息代替 |

版本/身份/执行窗口、真实来源与本轮清理是执行证据的组成部分。只发请求、PUBACK、S3 2xx、HTTP 200但图片未关联，均不能代替业务闭环。不得保存凭据、签名URL或图片Base64到审计日志。工具只能给 PASS_STRUCTURE_ONLY；独立复核真实来源后才在目标报告给 PASS_CLOUD_INTERFACES，不添加离线强制通过开关。

原44项用例保留为扩展回归，不要求在接口Gate前完成原生故障、24小时、容量/SLA、第三方App或真机。原FAIL/BLOCKED/NOT_RUN不改写；扩展套件完成情况另报。已发现的核心传图失败、越权或数据泄漏仍属于接口Gate失败。AR12继续使用原V1权限矩阵与单一源码N/A规则，其扩展分支不借此改成PASS。

## 已补齐的材料

[工作包目录](../audit/evidence/2026-11-08-device-image-cloud-interface-readiness/)包含：

- inputs.json：新profile、候选与protocolDigest绑定；填入9项确认沿用的环境定位，13项执行输入为null。
- input-provenance.json：记录本次用户确认、历史输入原SHA/Hash；没有把旧证明改成新目标证明。
- versions.review.json：对旧69c76e1d和当前d1a7b811的1693份交付源逐字节比较，差异0；历史原生迁移记录中的44份checksum与当前SQL全部匹配，schema也一致。仅离线源审查，不是当前目标版本/数据库状态证明，不自动部署或重复迁移。
- proof-drafts/：7份版本、迁移、运行接线、资源范围、执行窗口、序号、清理证明草稿；passed=false、capturedAt=null，不作为已获授权/已观察证据。
- cases.json、receipt.json：3项核心用例全部NOT_RUN，真实G4尚未执行。
- schedule.json：拟议45分钟顺序与责任边界，具体起止时间未提供，approved=false；不是已预订或已批准窗口。
- collectors/build-offline-package.py：仅本地文件和Git的可复现准备器，拒绝覆盖已执行回执或已补齐的执行输入。

9项定位是accountId、region、stackName、adminBaseUrl、deviceBaseUrl、mqttEndpoint、controlTable、payloadTable、archiveBucket。它们是用户确认沿用的环境定位，不表示资源健康或版本已经重新核验。

## 待补齐的13项及责任方

| 输入 | 提供/执行责任 |
|---|---|
| deployedCommit、deploymentProof | 云端发布/运维：核对真实运行制品、当前候选与五类函数版本；历史69观察不能直接改名为d1 |
| migrationProof | 云端数据库：本轮窗口内只读核对已有44项迁移和schema；本任务不执行迁移 |
| runtimeVersionsProof | 云端运维：核对五类函数版本、两表配置及全部权威入口使用当前版本 |
| deviceId、customerId | 云端测试负责人：准备独占隔离测试设备/客户，记录归属与基线；不借用现场设备 |
| deviceMtlsRef、mqttIdentityRef、viewerARef | 云端身份负责人：准备模拟客户端证书/MQTT与平台查看者，材料只填安全引用；不需要App源码或App测试报告 |
| testScopeProof | 云端测试负责人：限定一设备/一客户、CF01～CF03及模拟客户端；不含退役/共享故障 |
| executionWindowProof | 执行负责人：确认真实UTC起止与本轮runId；当前没有指定日期，不自行伪造批准 |
| sequenceReservation | 云端设备接入负责人：预留原始消息独占seq号段，记录当前基线及重试预算 |
| cleanupPlan | 云端运维：本轮租约、测试对象、关联和日志台账；不删除CONTROL、不倒退epoch、不扫全桶 |

这些是云端执行准备工作，由我方云端团队落实，不能转成等待第三方App测试的依赖。模拟设备仍需有效云端身份与预先批准的能力/白名单；本批不启用设备或创建目标业务资源。

## 执行安排与检查

先准备隔离身份/设备和时间窗 → 在授权窗口核对部署/存储/已有迁移 → CF01 → CF02 → CF03 → 清理与脱敏证据封存 → 离线回执校验及真实来源复核。45分钟只是计划估算，重试与身份准备可能延长，不是SLA，也不要求24小时等待。

```bash
python3 docs/audit/evidence/2026-11-08-device-image-cloud-interface-readiness/collectors/build-offline-package.py
node scripts/device-image-target-package.mjs --cloud-admission docs/audit/evidence/2026-11-08-device-image-cloud-interface-readiness/inputs.json
node scripts/device-image-target-package.mjs --cloud-receipt docs/audit/evidence/2026-11-08-device-image-cloud-interface-readiness/receipt.json docs/audit/evidence/2026-11-08-device-image-cloud-interface-readiness/inputs.json
```

当前admission预期退出2/BLOCKED（13项缺失），receipt预期退出2/NOT_RUN。准备器退出0只证明离线材料生成成功。完整操作顺序与S3签名/MQTT确认要求见[执行指南](../api/device-image-target-acceptance-guide.md)，JPEG/Base64使用既有冻结样例。

适用本地检查与机器记录见[result.json](../audit/evidence/2026-11-08-device-image-cloud-interface-readiness/result.json)：目标工具136项、全部脚本1658项、ESLint/Prettier/边界/证据/敏感信息检查通过。新增33项覆盖不依赖App或扩展环境、短窗口可用、过期窗口阻塞、旧候选/协议重放、图片/触发/字节不一致、业务未登记/未关联、版本混用和回执假通过。原103项仍通过。

## FAIL / BLOCKED / NOT_RUN

未解决本地FAIL=0。旧目标审计中的范围读取失败、历史40项迁移探针BLOCKED及旧候选绑定失败原样保留，未改写成当前真实通过。当前13项执行输入BLOCKED，窗口未确定，CF01～CF03真实执行NOT_RUN；原44项扩展回归及第三方App/真机状态独立保留。

本批不再重跑全量pnpm verify：业务交付源1693份无变更，应用候选已有完整22阶段G3证据，修改仅限独立版本的准备工具/文档；本批工具已完整脚本回归。没有调用真实云端、部署、连接/迁移目标库、启用设备或推送。

下一可执行任务：我方云端团队准备独占模拟设备/客户和安全身份引用，确认执行窗口，完成13项输入；届时按三项接口闭环进行真实G4，不等待第三方App/真机。目标业务资源创建与设备能力启用需在明确的隔离范围及授权下执行，本草稿不自动触发它们。
