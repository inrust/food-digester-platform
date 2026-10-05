# QA-09 非 Active 合法写入与目标浏览器语义验收

本执行器用于现有测试环境的独立业务夹具，不证明真实设备鉴权、自然 Active 或独立 HMAC 验签。应用版本先绑定成功的 CI、Deploy、Amplify 及19份 Lambda ZIP字节；执行器自身保存源码字节和哈希，允许只增加验收脚本而不改变部署应用。

```sh
export PATH=/Users/anray/.nvm/versions/node/v24.12.0/bin:$PATH
export QA09_EXPECTED_COMMIT=<40位已部署SHA>
export QA09_DEPLOY_RUN_ID=<同SHA成功部署Run>
node --import tsx scripts/collect-qa09-application-version.mjs <目录>/application-version.json
node --import tsx scripts/run-qa09-nonactive-target.mjs <目录>/business.json <目录>/application-version.json
```

GH_TOKEN只在调用进程中引用本机授权账户，不落文件。凭据、密码、JWT与签名下载地址不写回执。执行器通过 SRP 创建本轮五角色专用身份；客户角色使用本轮 Customer 声明，不修改 session 中的角色。浏览器使用真实目标域名与真实 API，禁止 route.fulfill/API mock。

设备夹具仅插入 Onboarded，随后通过真实分配 API 转到 Assigned。`nonActiveOnly`明确跳过完整设备许可证生命周期探针，不插入 Active、不发送 VERIFIED。合法写入包括合约、分配、配置、设备用户、耗材、告警及 Operator 元数据/客户更新；密码轮换回读验证版本增加和查询响应不包含密码字段。另执行管理端 License Draft→Issued→Active→Revoked；该 Active 只属于服务端 License 状态，并再次回读确认设备未进入 Active。

117项 Adopt/Adapt 由40个行为组分配，375/1440两个视口均有回执才通过。11项 Defer/Reject 单独登记。每组保存角色、时间窗、实际接口状态和 Gateway requestId；DOM只保存哈希，截图限定到不含其他客户内容的合约新建表单。可见控件不能证明数据链路或写入成功：无本轮媒体、传感器数据、证书、待审批 CSR 或 Active 的分支明确 NOT_RUN；邀请表单检查不发送外部邮件。未执行的合法角色/接口组合也明确 NOT_RUN。

`*.legal-writes.json`登记63接口 × 五角色。`HTTP_SUCCESS_OBSERVED`表示合法请求成功回执，持久化证明须关联显式API回读或独立 AWS 内数据库回执；不能以此单独宣称63接口全部业务通过。

清理顺序为业务依赖行、业务基线复核、站点、四个子身份、设备行及原设备/证书基线、两客户、SuperAdmin身份、唯一客户前缀的许可证归档版本。任何清理失败都会阻断 Gate。浏览器 FAIL 不掩盖已经完成的 API证据，也不跳过清理。整体 QA-09 继续独立计 Gate，不能由此局部结果升级为全部验收通过。


## 目标布局失败的受控诊断

仅在父夹具回执仍为`RUNNING`、相同已通过版本、严格本轮设备前缀和业务夹具模式时运行：

```sh
node --import tsx scripts/run-qa09-layout-diagnostic.mjs <目录>/layout-diagnostic.json <目录>/business.json.fixtures.json <目录>/application-version.json
```

执行器另建本轮临时身份、真实SRP与浏览器登录，仅读取本轮设备管理页；记录375/1440文档宽度、DOM选择器/边界/样式与文本长度，不保存文本内容、密码或Token。finally独立globalSignOut、删除并读取确认身份不存在；不修改业务数据。诊断前置拒绝外部设备、结束夹具、不同版本及非业务夹具模式。发现横向溢出后最终执行器的layoutGate/gate均为FAIL，不能用成功采集诊断冒充布局通过。

2026-10-05首次诊断回执来自保存的初版执行器字节；其gate=PASS表示诊断采集完成，pages明确记录375px文档667px及溢出，不表示验收通过。最终版已将该边界显式计入layoutGate；原回执与源码字节保留。分配历史非空表必须使用可聚焦、标记region/aria-label的table-scroll容器。QA05必需布局用例同时检查长字段、非空历史七列及键盘横向滚动，继续保留36例/108执行/零重试预算。

## 2026-10-05 数据与实体补充执行边界

数据波次仍用 `run-qa09-nonactive-target.mjs`，但增加受控 `business-seed-semantic-data`：仅在本轮十设备均已通过真实分配接口成为 Assigned、客户名称及站点客户一致且七张读模型表无本轮数据时插入。两客户各一个设备的 Telemetry 小时/日桶、活动、ESG Report/日汇总、耗材与离线状态均为 **SYNTHETIC_RDS_READ_MODELS_NO_DEVICE_INGESTION_OR_AUTH_CLAIM**。不更新生命周期、证书或 License 验签状态，不证明固件、硬件测量、MQTT/REPORT 接入或聚合计算。CustomerAdmin/CustomerViewer 必须只能读本客户样例，跨客户控制台必须404。

375/1440分别核对控制台 API 数值与 DOM、非空 ESG 表、INFO 活动筛选，并真实创建三种导出、轮询到 COMPLETED、点击下载 CSV、核对一条本轮记录与异步 Job 行数。回执保存列头、行数、字节数与哈希，并归档仅含本轮夹具的 CSV 字节；不保存下载授权 URL。所有已创建导出 ID 进入父清理账本；清理精确 S3 Key 的所有版本并回读零剩余，随后按设备/客户删除新增读模型和导出 Job，复核外部指纹不变。

实体波次使用 `run-qa09-entity-semantics-target.mjs`：

```sh
export QA09_EXPECTED_COMMIT=<实际已成功发布SHA>
export QA09_DEPLOY_RUN_ID=<同SHA部署runID>
node --import tsx scripts/run-qa09-entity-semantics-target.mjs csr <目录>/csr.json <目录>/application-version.json
node --import tsx scripts/run-qa09-entity-semantics-target.mjs certificate <目录>/certificate.json <目录>/application-version.json
```

`csr` 模式在独立十设备 PendingOnboarding 夹具上生成真实本地 CSR，通过真实公开申请入口建立申请；两视口各批准一个、拒绝一个并验证 If-Match、版本增长和状态/拒绝原因回读。其余六条保持待审。等待两份批准后的签发任务退出处理中再清理；该模式仅证明申请审核实体，不声称完成十设备 mTLS/Telemetry。

`certificate` 模式先完整运行已有十设备 CSR/mTLS/MQTT/Telemetry/归档验收，然后在两视口各选一个真实 Onboarded 设备，核对证书ID/指纹、MQTT/REST验证字段，真实提交并重放证书轮换意图，验证同一 PENDING 请求。不声称完成新 CSR 的轮换签发与双通道切换。父清理只删除本轮设备的轮换请求并验证外部请求指纹不变，再清理原有十设备资源。

三个波次必须顺序执行并使用不同新前缀，保存执行源码字节、父回执哈希和独立清理证据。应用 SHA 与本地执行器源码分别绑定；仅测试脚本变动无需把未发布脚本冒充为部署代码。邀请发送按用户指示保留 NOT_RUN。媒体上传后端要求 Active 或 Maintenance，Assigned 不能合法上传；该项必须如实登记生命周期前提，不用 SQL 构造媒体/证书冒充真实入口。

完成三个波次并确认清理后，用以下命令合并同应用版本、多独立夹具的117项语义回执：

```sh
node --import tsx scripts/collect-qa09-nonactive-semantics.mjs <目录> <目录>/semantic-summary.json
```

合并器拒绝缺失视口/决策、外部设备、版本未增长、伪造源字节、父回执哈希不符及清理失败；已验证下载只保存本轮 CSV，并绑定其字节哈希。此处 `scopeGate` 只评价八个新增数据/实体行为组；完整117项与整个QA-09仍按实际NOT_RUN保留PARTIAL。


### SSO 过期与未知提交结果恢复

CodeBuild 已成功但日志读取失效时，不能把缺失结果当作未提交。原失败回执及执行源码保持不变；以下恢复器只接收失败父账本和原成功 Build 回执，验证同一前缀/来源哈希后，通过现有 InfraSetup 读取原结果，观察实际夹具状态，精确清理并再次观察零剩余。删除回执中的设备列表是删除前快照，验收必须使用删除后观察结果。最后通过新 SUPPRESS 专用身份删除原两条客户并撤销该身份。

```sh
node --import tsx scripts/recover-qa09-nonactive-seed.mjs <失败父夹具回执> <原seed Build回执> <新恢复回执>
```

常规执行器在 seed 前取得外部基线，并在提交前登记可能已提交；finally 根据实际观察的零台/精确十台选择只读零集合证据或 cleanup。audit-empty 还要求客户已关闭，不能用于关闭客户前的恢复阶段。部分集合、外部设备或基线漂移均拒绝继续。明确的 SSO 过期不作为日志短暂延迟反复重试。此恢复不修改 IAM/KMS，也不重新发出旧 seed。


### 平台导出与失败业务清理恢复

平台角色创建的 ESG Job 的 customer_id 可以为空，客户/设备范围存于冻结 filters。清理不能只按 customer_id 判断本轮所有权。执行器把实际创建响应中的导出UUID传入 semanticExportIds；数据库同时验证精确ID和filters内客户/设备均属于本轮，拒绝外部筛选或重复/非法ID。原外部基线保持，未登记的全局Job仍是外部数据。

业务清理发生基线漂移时事务回滚；恢复器读取原seed与业务baseline回执，并按本轮已验证导出ID重新界定原始范围。新只读查询必须与原始外部指纹完全相同才会清理，不能直接采用当前漂移基线。业务依赖删除和审计通过后才删除十设备，再观察零剩余、删除精确站点/客户和许可域归档，最终撤销恢复身份。原失败父回执不改写，使用独立、不可变closed-ledger绑定域归档清理。

```sh
node --import tsx scripts/recover-qa09-nonactive-business.mjs <失败业务回执> <新恢复回执>
```

恢复器限定原失败为四份已验证ESG导出、十设备及原两客户场景；不作为任意清理入口。重复observe回执文件名含序号，避免覆盖seed前/清理前的独立证据。非空活动验证先核对API内本轮INFO事件，再等待表格和内容；耗材碳包37%与未提供的活性菌unknown分开验证。

### 非空数据与实体补验（2026-10-05）

本轮目标应用为a26bd94；执行器源码独立归档。最终数据波次使用明确标记的合成RDS读模型，真实API/租户隔离、活动与ESG实际CSV下载、双视口非空列/耗材进度通过，不能替代REPORT摄入或ESG计算。CSR实体按审核专用波次执行；证书实体按十设备真实CSR/mTLS波次执行，轮换仅验证PENDING意图及幂等性。范围与失败恢复记录见[非Active数据与实体续验记录](../audit/QA-09-剩余非Active数据与实体语义验收-2026-10-05.md)。
