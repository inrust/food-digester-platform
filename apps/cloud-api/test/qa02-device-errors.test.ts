import { test, expect } from 'vitest';
import { contractHandler } from '../../../contracts/testing/device-contract.js';
import {
  createCertificateStatusHandler,
  createDeviceSyncHandler,
  createDeviceDeactivateHandler,
  createDeviceMediaHandler,
  createOnboardingRequestHandler,
  createOnboardingStatusHandler,
} from '../src/index.js';
import { csrFixture } from './certificate-fixtures.js';

const now = () => new Date('2026-10-01T00:00:00Z');
const client = {} as any; // Unavailable DB port: actual Handlers must produce sanitized INTERNAL_ERROR.
const identity = { clientCertPem: '-----BEGIN CERTIFICATE-----\nY2VydA==\n-----END CERTIFICATE-----' };
const requestId = 'qa02-failure';

test.each([
  ['getCertificateStatus', () => createCertificateStatusHandler({ client, now })],
  ['syncDevice', () => createDeviceSyncHandler({ client, now, maintenanceSyncIntervalSeconds: 900 })],
  [
    'confirmDeactivation',
    () => createDeviceDeactivateHandler({ client, now, iot: { deactivateCertificate: async () => {} } }),
  ],
] as const)('QA-02 %s: DB outage response conforms and hides details', async (id, factory) => {
  const result = await contractHandler(id, factory())({ identity, requestId });
  expect(result.status).toBe(500);
  expect(result.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
});

test('QA-02 media upload: DB outage has a complete 500 response', async () => {
  const handler = contractHandler('createMediaUploadSession', createDeviceMediaHandler({ client, now } as any));
  const result = await handler({
    identity,
    requestId,
    body: { mediaType: 'IMAGE', fileName: 'snap.jpg', sizeKb: 1, sizeBytes: 1024, sha256: 'a'.repeat(64) },
  });
  expect(result.status).toBe(500);
});

test('QA-02 CSR submit/status: DB outage has a complete 500 response', async () => {
  const limiter = { assertWithinLimit: async () => {} };
  const submit = contractHandler(
    'submitOnboardingRequest',
    createOnboardingRequestHandler({ client, now, rateLimiter: limiter }),
  );
  const result = await submit({
    headers: {},
    requestId,
    body: {
      serialNumber: 'SN-QA02',
      model: 'BNX-100',
      hardwareVersion: '1',
      manufacturer: 'Bio-Nexa',
      manufactureDate: '2026-01-01',
      csrPem: csrFixture().csrPem,
    },
  });
  expect(result.status).toBe(500);
  const status = contractHandler(
    'getOnboardingStatus',
    createOnboardingStatusHandler({ client, now, rateLimiter: limiter } as any),
  );
  expect(
    (
      await status({
        headers: {
          'x-onboarding-timestamp': String(now().getTime()),
          'x-onboarding-nonce': 'n'.repeat(32),
          'x-onboarding-signature': 'stub-signature',
        },
        requestId,
        query: { requestId: '00000000-0000-0000-0000-000000000001' },
      })
    ).status,
  ).toBe(500);
});

test('QA-02 deactivate: device removed between identity check and business read yields declared 404', async () => {
  const racingClient = {
    deviceCertificate: {
      findFirst: async () => ({
        id: 'cert-race',
        deviceId: 'deleted-device',
        status: 'ACTIVE',
        revokedAt: null,
        notBefore: new Date(now().getTime() - 1000),
        notAfter: new Date(now().getTime() + 86400_000),
      }),
    },
    device: { findFirst: async () => null },
  } as any;
  const handler = contractHandler(
    'confirmDeactivation',
    createDeviceDeactivateHandler({ client: racingClient, now, iot: { deactivateCertificate: async () => {} } }),
  );
  expect((await handler({ identity, requestId })).status).toBe(404);
});
