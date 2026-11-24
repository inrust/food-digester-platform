import { createHash } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { withTransaction } from '@fdp/database';
import { validateConfigurationPayload } from '@fdp/domain';
import type { ConfigurationDerivedContext, EffectiveConfiguration } from '../admin/configuration/service.js';

export const CONFIGURATION_DELIVERY_SCHEMA_VERSION = 1;

export interface ConfigurationProtocol {
  readonly schemaVersion: number;
  readonly clientVersion: string;
}

export interface ConfigurationReceipt {
  readonly deliveryId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly status: 'RECEIVED' | 'APPLIED';
}

export interface ConfigurationDeliveryView {
  readonly schemaVersion: typeof CONFIGURATION_DELIVERY_SCHEMA_VERSION;
  readonly deliveryId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly effectiveAt: string;
  readonly settings: EffectiveConfiguration['payload'];
  readonly context: ConfigurationDerivedContext;
}

export function makeConfigurationDelivery(
  deviceId: string,
  configuration: EffectiveConfiguration,
  context: ConfigurationDerivedContext,
): ConfigurationDeliveryView {
  // Use stable field order. A change to the business context generates a distinct delivery identity.
  const { heartbeatInterval, telemetryInterval, cameraRefreshInterval, temperatureThreshold } =
    validateConfigurationPayload(configuration.payload);
  const content = {
    schemaVersion: CONFIGURATION_DELIVERY_SCHEMA_VERSION,
    configurationId: configuration.configurationId,
    version: configuration.version,
    effectiveAt: configuration.effectiveAt,
    settings: { heartbeatInterval, telemetryInterval, cameraRefreshInterval, temperatureThreshold },
    context,
  } as const;
  const deliveryId = createHash('sha256')
    .update(JSON.stringify([deviceId, configuration.versionId, content]))
    .digest('hex');
  return { ...content, deliveryId };
}

export async function recordConfigurationSync(
  client: DbClient,
  deviceId: string,
  at: Date,
  receipt: ConfigurationReceipt | undefined,
  outgoing: { readonly deliveryId: string; readonly versionId: string } | undefined,
): Promise<boolean> {
  if (!receipt && !outgoing) return true;
  return withTransaction(client, async (tx) => {
    if (receipt) {
      const prior = await tx.configurationDelivery.findFirst({
        where: {
          id: receipt.deliveryId,
          deviceId,
          version: { configurationId: receipt.configurationId, version: receipt.version },
        },
        select: { id: true },
      });
      if (!prior) return false;
      await tx.configurationDelivery.updateMany({
        where: { id: prior.id, receivedAt: null },
        data: { receivedAt: at },
      });
      if (receipt.status === 'APPLIED') {
        await tx.configurationDelivery.updateMany({
          where: { id: prior.id, appliedAt: null },
          data: { appliedAt: at },
        });
      }
    }
    if (outgoing) {
      await tx.configurationDelivery.createMany({
        data: { id: outgoing.deliveryId, deviceId, configurationVersionId: outgoing.versionId, servedAt: at },
        skipDuplicates: true,
      });
    }
    return true;
  });
}
