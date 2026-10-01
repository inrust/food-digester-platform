import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreatePolicyCommand,
  CreateThingCommand,
  DescribeEndpointCommand,
  IoTClient,
  RegisterCertificateWithoutCACommand,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import type { IotPolicyDocument } from './iot-device-policy.js';
import type { DeviceCertificateIssuer } from './project-ca-certificate-issuer.js';

export interface AwsIotCertificateResult {
  readonly certificateId: string;
  readonly certificateArn: string;
  readonly certificatePem: string;
  readonly certificateChain: string;
}

export interface AwsIotProvisioningClient {
  ensureThing(thingName: string): Promise<void>;
  issueAndRegisterCertificateFromCsr(csrPem: string, deviceId: string): Promise<AwsIotCertificateResult>;
  ensurePolicy(policyName: string, policyDocument: IotPolicyDocument): Promise<void>;
  attachPolicy(policyName: string, targetArn: string): Promise<void>;
  attachThingPrincipal(thingName: string, principalArn: string): Promise<void>;
  revokeCertificate(certificateId: string): Promise<void>;
  deactivateCertificate(certificateId: string): Promise<void>;
  getDataEndpoint(): Promise<string>;
}

export interface AwsIotProvisioningClientConfig {
  readonly client?: IoTClient;
  readonly region?: string;
  readonly certificateIssuer?: DeviceCertificateIssuer;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceAlreadyExistsException';
}

/** BE-ONB-03 生产 AWS IoT 适配器；ensure 操作允许同名资源重试。 */
export function createAwsIotProvisioningClient(config: AwsIotProvisioningClientConfig = {}): AwsIotProvisioningClient {
  const client = config.client ?? new IoTClient(config.region ? { region: config.region } : {});
  return {
    async ensureThing(thingName) {
      try {
        await client.send(new CreateThingCommand({ thingName }));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    },
    async issueAndRegisterCertificateFromCsr(csrPem, deviceId) {
      if (!config.certificateIssuer) throw new Error('缺少项目 CA 设备证书签发器');
      const issued = await config.certificateIssuer.issue(csrPem, deviceId);
      const response = await client.send(
        new RegisterCertificateWithoutCACommand({ certificatePem: issued.certificatePem, status: 'ACTIVE' }),
      );
      if (!response.certificateId || !response.certificateArn) {
        throw new Error('AWS IoT RegisterCertificateWithoutCA 返回不完整');
      }
      return {
        certificateId: response.certificateId,
        certificateArn: response.certificateArn,
        certificatePem: issued.certificatePem,
        certificateChain: issued.certificateChain,
      };
    },
    async ensurePolicy(policyName, policyDocument) {
      try {
        await client.send(new CreatePolicyCommand({ policyName, policyDocument: JSON.stringify(policyDocument) }));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    },
    async attachPolicy(policyName, targetArn) {
      await client.send(new AttachPolicyCommand({ policyName, target: targetArn }));
    },
    async attachThingPrincipal(thingName, principalArn) {
      await client.send(new AttachThingPrincipalCommand({ thingName, principal: principalArn }));
    },
    async revokeCertificate(certificateId) {
      await client.send(new UpdateCertificateCommand({ certificateId, newStatus: 'REVOKED' }));
    },
    async deactivateCertificate(certificateId) {
      await client.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
    },
    async getDataEndpoint() {
      const response = await client.send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }));
      if (!response.endpointAddress) throw new Error('AWS IoT DescribeEndpoint 返回不完整');
      return response.endpointAddress;
    },
  };
}
