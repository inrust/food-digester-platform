import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateKeysAndCertificateCommand,
  CreatePolicyCommand,
  CreateThingCommand,
  DescribeEndpointCommand,
  IoTClient,
  TagResourceCommand,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import type { IotPolicyDocument } from './iot-device-policy.js';

export interface AwsIotCertificateResult {
  readonly certificateId: string;
  readonly certificateArn: string;
  readonly certificatePem: string;
  readonly privateKey: string;
}

export interface AwsIotProvisioningClient {
  ensureThing(thingName: string): Promise<void>;
  createKeysAndCertificate(): Promise<AwsIotCertificateResult>;
  tagCertificate(certificateArn: string, tags: Readonly<Record<string, string>>): Promise<void>;
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
    async createKeysAndCertificate() {
      const response = await client.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
      const privateKey = response.keyPair?.PrivateKey;
      if (!response.certificateId || !response.certificateArn || !response.certificatePem || !privateKey) {
        throw new Error('AWS IoT CreateKeysAndCertificate 返回不完整');
      }
      return {
        certificateId: response.certificateId,
        certificateArn: response.certificateArn,
        certificatePem: response.certificatePem,
        privateKey,
      };
    },
    async tagCertificate(certificateArn, tags) {
      await client.send(
        new TagResourceCommand({
          resourceArn: certificateArn,
          tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
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
