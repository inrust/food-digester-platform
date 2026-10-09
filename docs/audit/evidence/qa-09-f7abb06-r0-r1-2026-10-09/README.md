# QA-09 f7abb06 新前缀 R0/R1

源码 `f7abb0670398a1254fcf45755f077b41f4fcd4c0`。仅复制历史辅助源码并保留来源哈希，不复制历史目标回执；所有本轮目标回执来自本轮新执行。

固定顺序：同SHA CI/默认关闭发布/Amplify/19实际工件与只读容量 → R0（engine/preconnect/detail=true，account=false）→ 原业务/严格阶段/自身清理及独立空集闭合 → R1新前缀（只改变account=true）→ 清理闭合 → 同SHA三个候选/预连/细分开关关闭恢复，engine保持true → 只读预算/空集/归档/Build终态复核。

不修改应用/IAM/KMS/容量，不邀请、不造冷、不扩样、不重放SQL或业务。pool1、API512MiB/node24/arm64/reserved12、静态63/可用70、业务并发≤6；各6基线PATCH/19审计GET、最多12独立采样PATCH/18审计GET、12认证负向。读取恢复只依预审阅执行器固定预算，保留原读FAIL；已失败原child/parent不能由补偿准入R1。

单元关闭辅助新增清理逐操作与新执行器源字节绑定，要求原child/parent PASS。不使用旧effective回执绕过原执行失败。匹配自然冷缺失、P95、纯compiler/server归因、网络节点、独立HMAC/自然Active/邀请及完整QA-09分别保持证据边界。

首次GitHub验证计数读取的自动审查超时未启动进程，已按工具允许重试一次成功；不作为GitHub/AWS失败归因。

## 本轮实际结果

R0 原wrapper FAIL (`EXECUTED_SOURCE_DRIFT`)：父快照遗漏两个新子执行器源；原子123业务/清理PASS、父汇总清理PASS。R1与12认证负向NOT_RUN，不重放业务。独立空集与原设备/证书基线、两客户S3归档零版本PASS。原基线collector漏ownership/pg边界失败保留，以相同ID新路径只读补采后基线25严格分段/物理冷409PASS；采样30严格分段PASS但无物理冷409，不补样。父非Active执行器逐操作字段仍NOT_OBSERVED。

同SHA关闭恢复37881924057 SUCCESS：engine=true，其余三开关false，19代码/非API revision不变，仅ApiFn差异。原本地gh等待TCP超时FAIL保留，恢复同一运行读取未重派部署。恢复后只读预算15/70、独立空集/原设备证书基线、两客户域零版本PASS。完整QA-09/P95为PARTIAL，匹配收益未建立。

目标执行/只读封存期间应用源码不变；之后的本地源清单修复属于新提交，不追溯改变本轮目标SHA。未使用生产凭据、邀请发送或IAM/KMS/容量变更。
