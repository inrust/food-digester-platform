import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  createLocalTestKeyProvider,
  SecurePackageService,
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  CERTIFICATE_PACKAGE_MAX_CLAIMS,
} from '@fdp/auth';
import type { QuarantineRecord } from '../src/index.js';
import {
  createBusinessDispatcher,
  createIngestionHandler,
  createOutboxPublisher,
  createArchiveWorker,
} from '../src/index.js';
import { createArchiveSqsHandler } from '../src/runtime/archive-entry.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';
// QA-01 is executable JavaScript; retain its generator as the integration input.
// @ts-expect-error QA-01 has no declaration file.
import { SimulatedDevice } from '../../../scripts/device-simulator/core.mjs';

export const TYPES = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'] as const;
export type RecordLike = { messageId: string; body: string };
export const sha = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
interface DeviceFixture {
  deviceId: string;
  certificateId: string;
  simulator: { payload(type: string): { meta: { id: string }; data: Record<string, unknown> } };
  sessionId: string;
  commandId: string;
}
export interface Qa03Fixture {
  pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
  prisma: Awaited<ReturnType<typeof createTestDb>>['prisma'];
  prefix: string;
  customerId: string;
  devices: DeviceFixture[];
  now: Date;
  record(type: (typeof TYPES)[number], index?: number): RecordLike;
  ingest: ReturnType<typeof createIngestionHandler>;
  publisher: ReturnType<typeof createOutboxPublisher>;
  archive: ReturnType<typeof createArchiveSqsHandler>;
  quarantine: QuarantineRecord[];
  archiveQueue: RecordLike[];
  objects: Map<string, Uint8Array>;
  faults: { ingestionId: string; quarantine: boolean; send: boolean; manifest: boolean };
  cleanup(): Promise<void>;
}
export async function createQa03Fixture(namespace: 'QA03' | 'QA07' = 'QA03'): Promise<Qa03Fixture> {
  const { pg, prisma } = await createTestDb();
  const prefix = `${namespace}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const now = new Date('2026-10-01T02:00:00.000Z');
  const quarantine: QuarantineRecord[] = [];
  const archiveQueue: RecordLike[] = [];
  const objects = new Map<string, Uint8Array>();
  const faults = { ingestionId: '', quarantine: false, send: false, manifest: false };
  const customerId = `${prefix}-CUSTOMER`;
  try {
    await prisma.customer.create({ data: { id: customerId, name: customerId } });
    const devices: DeviceFixture[] = [];
    for (let i = 0; i < 10; i++) {
      const deviceId = `${prefix}-DEV${i}`;
      const certificateId = `${prefix}-CERT${i}`;
      await prisma.device.create({
        data: {
          id: deviceId,
          serialNumber: deviceId,
          model: 'BNX-100',
          hardwareVersion: 'HW1.0',
          manufacturer: 'Hiddenjoy',
          manufactureDate: now,
          lifecycleStatus: 'Active',
          customerId,
        },
      });
      await prisma.deviceCertificate.create({
        data: {
          id: certificateId,
          deviceId,
          fingerprint: sha(certificateId),
          status: 'ACTIVE',
          notBefore: new Date('2026-01-01'),
          notAfter: new Date('2027-01-01'),
        },
      });
      await prisma.deviceCommand.create({
        data: {
          id: `${prefix}-CMD${i}`,
          deviceId,
          customerId,
          command: 'START',
          category: 'MACHINE',
          status: 'PUBLISHED',
          requestedBy: prefix,
          requestTime: now,
          timeoutSec: 120,
          expiresAt: new Date('2027-01-01'),
        },
      });
      const sessionId = `${prefix}-MEDIA${i}`;
      await prisma.mediaUploadSession.create({
        data: {
          id: sessionId,
          deviceId,
          customerId,
          mediaType: 'IMAGE',
          fileName: 'snapshot.jpg',
          sizeKb: 1,
          declaredSha256: sha(Buffer.alloc(1024)),
          presignedUrlExpiresAt: new Date('2027-01-01'),
        },
      });
      devices.push({
        deviceId,
        certificateId,
        simulator: new SimulatedDevice(deviceId, {}, {}, () => now),
        sessionId,
        commandId: `${prefix}-CMD${i}`,
      });
    }
    const dispatcher = createBusinessDispatcher({
      client: prisma,
      now: () => now,
      securePackage: new SecurePackageService({
        db: prisma,
        keyProvider: createLocalTestKeyProvider(prefix),
        config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: CERTIFICATE_PACKAGE_MAX_CLAIMS },
      }),
      certificateRevoker: { revokeCertificate: async () => {} },
      mediaStorage: {
        statObject: async () => ({ sizeBytes: 1024 }),
        computeSha256: async () => sha(Buffer.alloc(1024)),
      },
      mediaUploadPolicy: {
        getMediaTypes: () => ['IMAGE', 'VIDEO'],
        getMaxSizeKb: () => 204800,
        getDailyUploadQuotaPerDevice: () => 100,
        getUploadUrlTtlSeconds: () => 900,
        getDownloadUrlTtlSeconds: () => 900,
      },
    });
    const ingest = createIngestionHandler({
      client: prisma,
      quarantine: {
        send: async (record) => {
          if (faults.quarantine) {
            faults.quarantine = false;
            throw new Error('QA03 quarantine outage');
          }
          quarantine.push(record);
        },
      },
      onValidated: async (message) => {
        if (message.messageId === faults.ingestionId) {
          faults.ingestionId = '';
          throw new Error('QA03 transient dispatcher outage');
        }
        await dispatcher(message);
      },
    });
    const publisher = createOutboxPublisher({
      client: prisma,
      batchSize: 1000,
      sender: {
        send: async (message) => {
          if (faults.send) {
            faults.send = false;
            throw new Error('QA03 archive queue outage');
          }
          archiveQueue.push({ messageId: `SQS-${randomUUID()}`, body: JSON.stringify(message) });
        },
      },
    });
    const archive = createArchiveSqsHandler(
      createArchiveWorker({
        bucket: `${prefix}-local`,
        now: () => now,
        store: {
          putObject: async ({ key, body }) => {
            if (faults.manifest && key.endsWith('.manifest.json')) {
              faults.manifest = false;
              throw new Error('QA03 manifest outage');
            }
            objects.set(key, Uint8Array.from(body));
          },
        },
      }),
    );
    function record(type: (typeof TYPES)[number], index = 0): RecordLike {
      const device = devices[index]!;
      const payload = device.simulator.payload(type);
      if (type === 'ack') payload.data.commandId = device.commandId;
      if (type === 'media') {
        payload.data.objectPath = `media/${customerId}/${device.deviceId}/${device.sessionId}/snapshot.jpg`;
        payload.data.sizeKb = 1;
      }
      // IoT Rule SELECT * envelope model, not a claim that AWS delivered this message.
      return {
        messageId: `SQS-${randomUUID()}`,
        body: JSON.stringify(
          {
            ...payload,
            iotTopic: `bnx/device/${device.deviceId}/${type}`,
            iotDeviceId: device.deviceId,
            iotType: type,
            iotReceivedAt: now.getTime(),
            iotPrincipal: `arn:aws:iot:ap-southeast-1:123456789012:cert/${device.certificateId}`,
          },
          null,
          2,
        ),
      };
    }
    let closed = false;
    async function cleanup() {
      if (closed) return;
      await prisma.$disconnect();
      await pg.close();
      quarantine.length = 0;
      archiveQueue.length = 0;
      objects.clear();
      closed = true;
    }
    return {
      pg,
      prisma,
      prefix,
      customerId,
      devices,
      now,
      record,
      ingest,
      publisher,
      archive,
      quarantine,
      archiveQueue,
      objects,
      faults,
      cleanup,
    };
  } catch (error) {
    await prisma.$disconnect();
    await pg.close();
    throw error;
  }
}

export async function withQa03Fixture(
  name: string,
  run: (fixture: Awaited<ReturnType<typeof createQa03Fixture>>) => Promise<Record<string, unknown>>,
) {
  const fixture = await createQa03Fixture();
  let metrics: Record<string, unknown> | undefined;
  try {
    metrics = await run(fixture);
  } finally {
    await fixture.cleanup();
  }
  if (metrics && process.env.QA03_TRACE)
    appendFileSync(
      process.env.QA03_TRACE,
      JSON.stringify({ name, prefix: fixture.prefix, status: 'PASS', cleanup: 'PASS', ...metrics }) + '\n',
    );
}
