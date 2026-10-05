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
