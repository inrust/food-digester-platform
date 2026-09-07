/**
 * BE-ONB-03 IoT Provisioning 端口（Hexagonal Port）。
 *
 * cloud-api 不直接依赖 AWS SDK：端口注入实现（生产适配器在 @fdp/aws-clients 接线，
 * 测试用内存 mock）。所有操作必须幂等（ensure* 语义），支撑部分失败重试。
 */
import type { IotPolicyDocument } from '@fdp/aws-clients';

export interface IotCertificateResult {
  readonly certificateId: string;
  readonly certificateArn: string;
  readonly certificatePem: string;
  /** 私钥明文：仅内存经过，立即经 SEC-01 信封加密落库；禁止日志/审计。 */
  readonly privateKey: string;
}

export interface IotProvisioningPort {
  /** 创建 IoT Thing（幂等：同名已存在视为成功）。Thing Name = deviceId。 */
  ensureThing(thingName: string): Promise<void>;
  /** CreateKeysAndCertificate（非幂等：每次调用产生新证书；重试孤儿证书由 Service 处置）。 */
  createKeysAndCertificate(): Promise<IotCertificateResult>;
  /** 用持久化 request/operation 标识证书，支持 CloudTrail/AWS IoT 对账。 */
  tagCertificate(certificateArn: string, tags: Readonly<Record<string, string>>): Promise<void>;
  /** 创建单设备最小权限 Policy（幂等：同名已存在视为成功；文档由 AUTH-04 生成）。 */
  ensurePolicy(policyName: string, policyDocument: IotPolicyDocument): Promise<void>;
  /** 附加 Policy 到证书（幂等）。 */
  attachPolicy(policyName: string, targetArn: string): Promise<void>;
  /** 附加证书到 Thing（幂等）。 */
  attachThingPrincipal(thingName: string, principalArn: string): Promise<void>;
  /** 撤销不再可信的未确认证书（幂等：已撤销视为成功）。 */
  revokeCertificate(certificateId: string): Promise<void>;
}
