# 管理后台真实目标环境验收：阶段记录

## 结论与版本

验收对象为 `cb5beaaeb50132045427c55542263c5f2e846496`。用户确认已推送该提交，并确认真实管理员参与使用、可用性 OK；记为 **人工可用性 PASS（用户确认）**。

本轮独立验证状态为 **PARTIAL / 临时账号提交待确认**，不等于全部功能、五角色、跨 Customer、并发或生产验收通过。以下证据均来自真实已部署服务或当前已登录浏览器，未使用 mock；普通本地回归与目标环境验收继续分别记录。

AWS 只读查询确认 `admin.bio-nexa.com` 为 `fdp-test-app` 的 AdminWebOrigin，账户 `065986019555`、区域 `ap-southeast-1`，环境标签 **test**。因此本轮为已有真实测试环境验收，不能仅因自定义域名而称作生产数据验收。

Amplify 应用 `d29sdr89i4zl0`、main 分支 job 50 为 SUCCEED，部署提交与验收提交完全一致。当前管理员 API Lambda 为 Active / Successful；其 CodeSha256 与历史 `b885e11` 已验证制品一致，且 `apps/cloud-api`、`packages`、`contracts/rest`、`infra` 的 Git tree 无变化。这支持 API 制品和相关源码的延续性核查；本轮 GitHub API 返回 404，未宣称当前提交的 CI 或后端部署流水线已独立复核成功。

## 控制点与实际结果

| 控制点 | 本轮结果 | 证据及限制 |
| --- | --- | --- |
| 人工可用性 | USER CONFIRMED PASS | 用户直接确认；不伪造访谈记录或自动化回执 |
| 前端实际部署版本 | PASS | Amplify job 50，完整 SHA 一致 |
| 真实 Cognito 配置 | PASS（配置核实） | 用户池 `ap-southeast-1_hZMX8LpFo`、客户端 `5ljdjsf9g563mc1vdc7vjdjm09`、SRP、五种角色存在；不等于五角色登录通过 |
| 已登录管理员业务读写 | PASS（限定流程） | 新建两个 Customer、两个 Site；页面持久化结果及四条真实审计 requestId |
| 未认证访问拒绝 | PASS | `/admin/customers`、`/admin/sites` 真实 API 均返回 401，保存网关 requestId |
| UI 重复提交保护 | PASS（限定一次） | Site B 保存双击，最终一个站点、一条 site.create 审计；未声称覆盖所有写接口 |
| If-Match 并发竞争 | NOT RUN | 尚未获得临时受限账号会话；重复点击不等于并发乐观锁验证 |
| 跨 Customer 隔离 | NOT RUN | 两个 Customer/Site 已准备；两个账号尚未创建，不能用 SuperAdmin 的访问能力证明隔离 |
| 五角色目标登录 | NOT RUN | 当前只观察到已登录 PlatformSuperAdmin；不读取浏览器 Token 或现有账号密码 |
| 全业务目标回归 | NOT RUN / 部分页面检查 | 多数列表为空，现有两台设备离线；没有执行终端命令、设备同步、OTA 成功、媒体短链到期、真实导出多页一致性等链路 |
| 中英文当前页面 | PASS（限定概览） | 实际 732×878 视口，中英文截图，无横向溢出；语言已恢复简体中文 |
| 目标桌面 1366×768 | UNVERIFIED | 请求视口覆盖后 DOM 仍为 732×878，截图按实际尺寸命名；覆盖已重置 |
| 四浏览器桌面兼容 | 历史本地 PASS | 原报告 132 项，隔离 fixture；不能替代本轮目标环境浏览器矩阵 |
| 生产数据 | NOT VERIFIED | 当前确认的基础设施环境为 test |
| 清理 | PENDING | 自建四条业务记录保留用于后续验收；账号不存在；未声称清理完成 |

## 页面与数据检查

通过当前菜单及管理按钮检查概览、设备群、设备查看选择器、设备管理详情、设备操作、配置、耗材、告警、媒体、ESG 两页、合约列表/创建表单、授权、站点、客户、设备用户、用户管理、审计、OTA 固件包/Campaign 入口。

配置、告警、媒体、ESG、合约、授权和 OTA 列表正常加载为空。耗材对未上报值展示 unknown。概览两台设备均离线，快捷动作禁用并展示 DEVICE_OFFLINE。设备详情可显示证书摘要与暂无分配记录。合约创建表单展示必填校验且提交禁用；未提交、激活任何合约。审计筛选可定位本轮对象，详情可查看 requestId，Escape 可关闭详情。

这些结果只证明当前页面加载、有限数据展示和所述交互，不证明空数据下无法触发的业务流程。概览授权分布显示 `ACTIVE 2`，设备卡片授权轴显示 `—`，授权列表为空；暂记为需结合 API 数据进一步解释的观察，未无依据认定为 UI 缺陷。

## 临时测试数据与待确认账号

| 对象 | ID | 当前状态 |
| --- | --- | --- |
| UI-ACCEPT-20261004-Customer-A | `94371262-8afe-4fab-b748-2fb6d95c2bcd` | ACTIVE |
| UI-ACCEPT-20261004-Customer-B | `54bcc341-d8c5-4624-b694-d0702282105d` | ACTIVE |
| UI-ACCEPT-20261004-Site-A | `2c8bca29-c681-434c-8af7-3b0afe3e8a54` | ACTIVE，属于 A |
| UI-ACCEPT-20261004-Site-B | `d8fa1d22-83ad-43d6-a01c-8c15715409a9` | ACTIVE，属于 B |

用户已要求由代理设置两个临时 Customer 账号。拟创建 `ui-accept-20261004-a@example.invalid`（CustomerAdmin，仅 A）和 `ui-accept-20261004-b@example.invalid`（CustomerViewer，仅 B）。浏览器工具规则要求创建安全敏感访问权限在提交时确认；已发送具体确认项，**邀请尚未提交、账号尚未创建**。A 表单准备完成并保留于当前标签页。上述 `.invalid` 地址为测试标识，不能接收临时密码邮件；登录凭证取得方式尚未执行或验收。仓库不保存密码或 Token。

确认后的后续步骤：创建并核对两个账号的绑定/角色；通过真实 Cognito 建立会话；验证本租户正向访问和对方 Site/对象拒绝、Viewer 写入拒绝；仅针对自建记录执行同版本并发更新（一成功、一 409）和恢复；停用临时账号并清理/停用本轮自建记录，保存审计与残留核对。设备、媒体、导出、OTA 等完整链路还需要明确的可用目标数据及设备状态，不能由站点隔离结果替代。

## 正式目标 Gate 与证据

针对验收提交运行三个 Gate 的检查函数，默认回执均缺失：

- `check:admin-web-target-evidence`：`fe-06-10-admin-web-target.json` 缺失。
- `check:admin-web-fe11-15-target-evidence`：`fe-11-15-admin-web-target.json` 缺失。
- `check:admin-web-fe16-19-target-evidence`：`fe-16-19-admin-web-target.json` 缺失。

继续保持 **NOT RUN / NO RECEIPT**，未填写占位 PASS 或弱化 Gate。

本轮证据目录：[admin-ui-target-2026-10-04](evidence/admin-ui-target-2026-10-04)。核心文件：[阶段回执](evidence/admin-ui-target-2026-10-04/incremental-verification.json)、[环境查询](evidence/admin-ui-target-2026-10-04/environment-observations.json)、[自建记录台账](evidence/admin-ui-target-2026-10-04/owned-fixture-ledger.json)、[四次写入审计](evidence/admin-ui-target-2026-10-04/owned-write-audits.json)、[页面观察](evidence/admin-ui-target-2026-10-04/route-observations.json)、[实际视口](evidence/admin-ui-target-2026-10-04/viewport-observation.json)。审计详情中的 IP 已脱敏；初始加载中观察保留为历史快照，后续配置页面已加载为空。

本记录为阶段证据归档，后续执行应以本轮台账精确匹配对象，避免影响原有账号、设备及历史记录。所有提交仅在本地创建，远程推送由人工执行。
