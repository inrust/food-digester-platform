# QA-09 Gateway真实字段入口与同SHA对照复验

本手册补充[辅助采集分页批处理与入口复验](QA-09-辅助采集分页批处理与入口复验.md)，原业务预算、SSO余量、未知启动禁止重复、清理顺序与阶段门禁全部保持。f7f996f只有默认关闭/19工件核验，没有新R0/R1业务回执；不能把未推送QA修复用于该SHA并宣称通过。

## 入口

1. 人工通过GitHub Desktop推送时间戳修复；核对新完整SHA CI、默认关闭部署、实际19工件和五候选false。新辅助清单绑定通用采集器、reader、独立校验器和全部阶段依赖。
2. 在启动容量或业务夹具前，执行隔离Python/任意cwd真实入口检查和134项专项。字段兼容输入必须同时包含真实模板的数字字符串、已保存初始化及负向Gateway形状，并保留原字段类型；只使用数字的成功矩阵不够。
3. 拒绝空白/指数/小数串/前导零/Unicode数字/空字符串/布尔/null/负值/非整数/不安全整数；合法字符串仍须通过原时间窗和逐请求客户端时间、延迟、ID/status/invocation校验。
4. 离线历史回放只证明解析及所有权，必须标记零AWS/零新业务，不能充当新轮辅助初始化、无SQL或性能回执。历史REPORT投影重建必须注明。
5. 已推送SHA源码与当前执行器有差异时停止入口；不得靠未发布工作区修复绕过同SHA绑定。

```sh
python3 -I scripts/collect-qa09-auxiliary-phases.py --check-import
node --test scripts/qa09-auxiliary-read.test.mjs scripts/check-qa09-auxiliary-read.test.mjs
```

## 目标顺序

入口闭合后执行唯一只读容量预检及新前缀R0，engine/preconnect/account/detail/public=true、observer=false；原业务、父子清理、独立空集、55主关联、初始化8条/负向12条辅助归属及严格阶段全部通过才能进入R1。R1仅切observer=true，保持同SHA和原预算，完成原清理/独立空集后同SHA关闭恢复五候选false、engine=true。

恢复核对19代码字节及18非API revision、实际配置、只读容量、两组自有数据库空集/原设备证书指纹、归档当前/历史版本和全部精确自有Build终态。业务或采集失败不补样、不升级原回执，优先清理及关闭恢复；启动前格式阻断且未开启配置/创建夹具时恢复为NOT_REQUIRED，保留阻断证据。

120秒/40次/20页/15秒、每批最多3自有ID、串行零自动重试、预算和严格5ms阶段门禁不变。新目标匹配冷样本及收益须另证；本轮不追加TCP/TLS探针，不调整IAM/KMS/容量，不开展独立验签、自然Active或邀请发送。
