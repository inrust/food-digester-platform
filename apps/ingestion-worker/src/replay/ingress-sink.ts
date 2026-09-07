import type { JsonMessageSender } from '@fdp/aws-clients';
import type { DbClient } from '@fdp/database';
import type { ReplayIngressSink } from './worker.js';

interface CertificateRow {
  readonly id: string;
}

/**
 * 重放记录恢复为 IoT Rule 的扁平 SQS envelope，并使用设备当前 ACTIVE 证书 ARN。
 * 不复用归档时的旧 principal，避免已撤销证书绕过 BE-IOT-01 认证绑定。
 */
export function createReplayIngressSink(deps: {
  readonly client: DbClient;
  readonly sender: JsonMessageSender;
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly now?: () => Date;
}): ReplayIngressSink {
  const certificates = (deps.client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
    }): Promise<CertificateRow | null>;
  };
  const now = deps.now ?? (() => new Date());
  return {
    async send(record) {
      if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
        throw new Error('Archived replay payload must be an object');
      }
      const checkAt = now();
      const certificate = await certificates.findFirst({
        where: {
          deviceId: record.iotDeviceId,
          status: 'ACTIVE',
          revokedAt: null,
          notBefore: { lte: checkAt },
          notAfter: { gt: checkAt },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!certificate) throw new Error(`No ACTIVE certificate for replay device: ${record.iotDeviceId}`);
      await deps.sender.send({
        ...(record.payload as Record<string, unknown>),
        iotTopic: record.iotTopic,
        iotDeviceId: record.iotDeviceId,
        iotType: record.iotType,
        iotReceivedAt: record.iotReceivedAt,
        iotPrincipal: `arn:${deps.partition}:iot:${deps.region}:${deps.accountId}:cert/${certificate.id}`,
      });
    },
  };
}
