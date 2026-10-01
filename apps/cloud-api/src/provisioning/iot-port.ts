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
  /** 签发 CA 至根 CA 的公共 PEM 链；没有设备私钥字段。 */
  readonly certificateChain: string;
}

export interface IotProvisioningPort {
  /** 创建 IoT Thing（幂等：同名已存在视为成功）。Thing Name = deviceId。 */
  ensureThing(thingName: string): Promise<void>;
  /** 项目 CA 签发并注册到 AWS IoT（非幂等；重试孤儿证书由 Service 处置）。 */
  issueAndRegisterCertificateFromCsr(csrPem: string, deviceId: string): Promise<IotCertificateResult>;
  /** 创建单设备最小权限 Policy（幂等：同名已存在视为成功；文档由 AUTH-04 生成）。 */
  ensurePolicy(policyName: string, policyDocument: IotPolicyDocument): Promise<void>;
  /** 附加 Policy 到证书（幂等）。 */
  attachPolicy(policyName: string, targetArn: string): Promise<void>;
  /** 附加证书到 Thing（幂等）。 */
  attachThingPrincipal(thingName: string, principalArn: string): Promise<void>;
  /** 撤销不再可信的未确认证书（幂等：已撤销视为成功）。 */
  revokeCertificate(certificateId: string): Promise<void>;
}
