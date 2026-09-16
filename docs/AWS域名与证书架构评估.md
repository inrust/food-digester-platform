# AWS 域名与证书架构评估

评估日期：2026-09-15。性质：架构建议，未执行 DNS、证书申请或 AWS 部署。

## 1. 结论

原规划的业务命名总体适合，但 `api.bio-nexa.com` 不宜同时承担管理 JWT API 和接入后设备 mTLS API。建议保留 iot、api、admin、platform，增加 device-api 和 onboard-api，形成按认证边界拆分的入口。

| 生产域名 | 用途 | AWS 入口及认证 | 结论 |
|---|---|---|---|
| `iot.bio-nexa.com` | 设备运行时 MQTT | IoT Core 自定义 DATA Domain Configuration；设备 X.509 | 适合；WSS 需另外确定认证方案 |
| `api.bio-nexa.com` | 管理及客户业务 REST API | API Gateway；Cognito JWT 与服务端 RBAC/Customer scope | 适合；移出设备 mTLS 接口 |
| `device-api.bio-nexa.com` | 接入后设备 Sync、Certificate、Lifecycle 等 REST | Regional API Gateway 自定义域名；mTLS 与应用层设备身份检查 | 建议新增，P0 |
| `onboard-api.bio-nexa.com` | 首次接入及证书包领取 | 独立 API Gateway 入口；Onboarding Token、Token/IP 限流 | 建议新增，P0 |
| `admin.bio-nexa.com` | 管理后台 Web | Amplify Hosting；用户通过 Cognito 登录 | 适合 |
| `platform.bio-nexa.com` | 将来的客户登录平台 | 独立前端应用；独立 Cognito App Client 或 User Pool | 可预留；当前不必部署 |

域名拆分不要求复制全部后端业务服务；API 可以调用共享领域服务，但入口认证、路由权限、限流和日志须独立。客户平台是否单独开发属于产品决策；现有后台已包含 CustomerAdmin/CustomerViewer，不能仅因预留域名就认定需要新增一套业务系统。

## 2. 文档依据与差异

- `docs/Device-Cloud-Communication-Design-解析.md` §4：MQTT 使用 Device X.509；REST 接入前使用 QR/Onboarding Token，接入后使用 X.509 + mTLS；REST 路径保留 `/api/v1/`。
- `docs/管理后台开发任务清单.md` IAC-01：Device API 与 Onboarding API 独立入口；AUTH-01/03：Cognito JWT 与设备证书身份映射属于不同认证链；FE 页面不直接透传 MQTT 原始消息。
- `docs/AWS云端运维任务清单.md` OPS-EDGE-001：明确 onboard-api、device-api、api 三类入口；OPS-BASE-001 与 OPS-EDGE-002：环境资源和 Cognito 隔离。
- 运维清单 OPS-EDGE-003、§19 成本优化仍描述 S3 + CloudFront 手动托管；当前 `docs/AWS运维账号权限与服务预算申请说明.md` 明确改为 Amplify Hosting GitHub 自动发布。本评估沿用当前 Amplify 决定，建议后续同步运维清单，不为管理前端重复搭建 S3 + CloudFront。
- 当前预算申请仅覆盖单套测试环境；本文件规划后续 dev/staging/prod 命名，不将其视为立即开通三套环境或扩大预算的授权。

## 3. IoT Core 接入

`iot.bio-nexa.com` 应直连 IoT Core，而非 API Gateway、Amplify 或普通 CloudFront 分发。必须同时完成 ACM 服务端证书、IoT Domain Configuration 和 CNAME 指向该账号/Region 的 `iot:Data-ATS` Endpoint；只配置 CNAME 不足以让 IoT 提供正确证书。设备 TLS SNI 必须与自定义域名一致。[AWS 自定义 IoT 域名](https://docs.aws.amazon.com/iot/latest/developerguide/iot-custom-endpoints-configurable-custom.html)

设备基线建议 MQTT over TLS 8883 + X.509；若使用 443，按所选 Domain Configuration 确认 ALPN/认证组合。MQTT over WSS 的地址为 `wss://iot.bio-nexa.com/mqtt`，支持 SigV4 或 Custom Authorizer，不能直接沿用 MQTT TLS 的 X.509 认证假设；Cognito User Pool JWT 也不等于 SigV4 凭据。当前三份文档未把 WSS 定为设备必需能力，建议作为可选接入方案另行设计、验证。[AWS 协议与认证矩阵](https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html)

IoT HTTPS 消息发布接口不是项目 Device REST API，不能用 IoT Endpoint 替代 `/api/v1/device/sync` 等业务路由。管理 Web 实时需求优先通过受业务授权控制的后端接口实现；若未来浏览器直连 IoT，必须另设最小权限和 Topic/租户边界。

## 4. API Gateway 与 mTLS

mTLS 配置在自定义域名 TLS 握手层，HTTP 路径尚未参与路由。因此不能在同一域名上仅用 `/admin`、`/device`、`/onboard` 区分“需要客户端证书”和“不需要客户端证书”。保持 `api`、`device-api`、`onboard-api` 分离最贴合现有文档。[AWS API Gateway mTLS](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html)

Device API 使用 Regional 自定义域名，直接到达 API Gateway；不在其前方增加普通 CloudFront TLS 终止，否则原设备 TLS 客户端证书无法按现有 API Gateway mTLS 链路传递。关闭设备 API 默认 `execute-api` Endpoint，并确认其他域名映射不能绕过 mTLS。Truststore 存放于受控、版本化 S3；API Gateway 不检查证书撤销，仍须按 AUTH-03 校验证书 Active 状态、有效期、Device 归属与停用状态。[AWS mTLS 约束与默认端点说明](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-mutual-tls.html)

后端 API 类型须与现有 IaC 和授权配置一致：REST API 使用 Cognito User Pool Authorizer，HTTP API 使用 JWT Authorizer；不能因为域名规划就默认切换 API 类型。主机名变化不要求改写协议路径，映射需防止丢失或重复 `/api/v1/` 前缀。

## 5. Amplify、CloudFront 与证书

| 使用位置 | 证书规划 |
|---|---|
| IoT 自定义域名 | 在目标 IoT 账号/业务 Region 配置 ACM 服务端证书；与设备客户端证书分开管理 |
| Regional API Gateway | ACM 服务端证书与 API 同 Region；device-api 另配置客户端 CA Truststore |
| Amplify 管理后台 | 优先使用 Amplify 托管证书与续期；使用自定义 ACM 证书时要求 `us-east-1` |
| 自建 CloudFront（若另有业务用途） | Viewer HTTPS ACM 证书必须位于 `us-east-1`；证书 SAN 覆盖分发域名 |

Regional 证书要求见 [API Gateway 官方说明](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-regional-api-custom-domain-create.html)；前端证书要求见 [Amplify 证书说明](https://docs.aws.amazon.com/amplify/latest/userguide/using-certificates.html)、[CloudFront 证书要求](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)。ACM ARN 具有账号/Region 边界，不能把一张证书 ARN 当作跨账号、跨 Region 通用资源。

优先按环境、服务申请精确主机名证书，避免生产与测试复用大范围通配证书。特别是 IoT，某账号注册通配证书后会阻止同 Region 其他账号创建与其覆盖范围重叠的自定义域名；生产 IoT 不应使用覆盖整个 `*.bio-nexa.com` 的证书，以免影响未来独立测试账号。[AWS IoT 通配证书约束](https://docs.aws.amazon.com/iot/latest/developerguide/iot-custom-endpoints-configurable-custom.html)

ACM 服务端 HTTPS 证书、设备客户端 X.509、设备 CA/Truststore 是不同资源。ACM 公有域名证书不负责签发设备身份；Truststore CA 也不负责网站域名 HTTPS。保留 DNS 验证记录，并监控服务端证书及设备 CA/Truststore 到期、续期和轮换。

## 6. 上线前验收

1. 每环境完成 DNS、SNI、服务端证书链及 MQTT 连接测试；错误环境/停用设备证书连接失败。
2. Onboarding 无设备证书仍能按 Token 协议工作；Device API 无证书、不可信/过期证书被拒绝，停用证书由应用层拒绝，默认端点及其他映射无法绕过。
3. 管理 API 拒绝缺失、过期、错误环境 JWT；验证角色和跨租户越权。
4. Amplify 自定义域名、首次构建、SPA 深链接、API CORS、Cognito 回调及缓存发布/回退通过。
5. 证书续期、CA/Truststore 轮换、配置回退与 DNS 变更责任人明确，保留可追踪证据。

本次仅完成文档与 AWS 官方约束核对；未核实域名所有权、当前 DNS、AWS 账号/Region 或实际服务支持配置。目标环境连接及部署验收：NOT RUN / NO RECEIPT。
