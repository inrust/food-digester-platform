import {
  AttachPolicyCommand,
  AttachThingPrincipalCommand,
  CreateKeysAndCertificateCommand,
  CreatePolicyCommand,
  CreateThingCommand,
  DescribeEndpointCommand,
  UpdateCertificateCommand,
} from '@aws-sdk/client-iot';
import type { IoTClient } from '@aws-sdk/client-iot';
import { assert, describe, expect, test } from 'vitest';
import { createAwsIotProvisioningClient } from '../src/iot-provisioning-client.js';

describe('AWS IoT provisioning 生产适配器', () => {
  test('完整映射签发、策略附加、Thing 附加和撤证命令', async () => {
    const calls: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        calls.push(command);
        if (command instanceof CreateKeysAndCertificateCommand) {
          return {
            certificateId: 'cert-1',
            certificateArn: 'arn:cert-1',
            certificatePem: 'pem',
            keyPair: { PrivateKey: 'private-key' },
          };
        }
        if (command instanceof DescribeEndpointCommand) {
          return { endpointAddress: 'example-ats.iot.ap-southeast-1.amazonaws.com' };
        }
        return {};
      },
    } as unknown as IoTClient;
    const adapter = createAwsIotProvisioningClient({ client });
    await adapter.ensureThing('device-1');
    await expect(adapter.createKeysAndCertificate()).resolves.toMatchObject({ certificateId: 'cert-1' });
    await adapter.ensurePolicy('policy-1', { Version: '2012-10-17', Statement: [] });
    await adapter.attachPolicy('policy-1', 'arn:cert-1');
    await adapter.attachThingPrincipal('device-1', 'arn:cert-1');
    await adapter.revokeCertificate('cert-1');
    await expect(adapter.getDataEndpoint()).resolves.toBe('example-ats.iot.ap-southeast-1.amazonaws.com');

    assert.deepEqual(
      calls.map((command) => (command as { constructor: { name: string } }).constructor.name),
      [
        CreateThingCommand.name,
        CreateKeysAndCertificateCommand.name,
        CreatePolicyCommand.name,
        AttachPolicyCommand.name,
        AttachThingPrincipalCommand.name,
        UpdateCertificateCommand.name,
        DescribeEndpointCommand.name,
      ],
    );
    assert.deepEqual((calls.at(-2) as UpdateCertificateCommand).input, {
      certificateId: 'cert-1',
      newStatus: 'REVOKED',
    });
    assert.deepEqual((calls.at(-1) as DescribeEndpointCommand).input, { endpointType: 'iot:Data-ATS' });
  });

  test('ensure 操作仅吞掉 ResourceAlreadyExistsException', async () => {
    const alreadyExists = Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' });
    const client = { send: async () => Promise.reject(alreadyExists) } as unknown as IoTClient;
    const adapter = createAwsIotProvisioningClient({ client });
    await expect(adapter.ensureThing('device-1')).resolves.toBeUndefined();
    await expect(adapter.ensurePolicy('policy-1', { Version: '2012-10-17', Statement: [] })).resolves.toBeUndefined();
  });
});
