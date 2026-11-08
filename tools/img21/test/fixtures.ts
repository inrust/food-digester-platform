import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bindManifest, digest, TARGET } from '../contracts.js';
import type { Manifest, Invocation, BoundManifest, WriteRequest } from '../contracts.js';
import type { CognitoIdentity, WriterDependencies } from '../controlled-writer.js';
import { createControlledWriter } from '../controlled-writer.js';
import { withLiveImageAuthority, deviceCertificateMetadata } from '@fdp/aws-clients';
import type { LiveImageControl, LiveImageControlStore } from '@fdp/domain';
import { createTestDb } from '../../../apps/cloud-api/test/helpers.js';
import { certificateForCsr, csrFixture } from '../../../apps/cloud-api/test/certificate-fixtures.js';
export const NOW = Date.parse('2026-11-08T12:01:00.000Z');
const csr = csrFixture();
export const pem = certificateForCsr(csr.csrPem, 'local-fixture', new Date('2026-11-08T12:00:00Z')).certificatePem;
export const cert = deviceCertificateMetadata(pem);
export function manifest(overrides: Partial<Manifest> = {}): BoundManifest {
  const m: Manifest = {
    formatVersion: 1,
    runId: 'IMG21-LOCAL-' + randomUUID(),
    applicationCommit: 'd1a7b81196d60ec320e760da3d18de403563fc12',
    toolCommit: 'a'.repeat(40),
    approvalRef: 'LOCAL_FIXTURE_ONLY_NOT_AUTHORIZATION',
    window: { startsAt: '2026-11-08T12:00:00.000Z', endsAt: '2026-11-08T13:30:00.000Z' },
    serialNumber: 'img21-0123456789abcdef',
    model: 'IMG21-LOCAL',
    customerName: 'Local own customer',
    siteName: 'Local own site',
    csrPublicKeyFingerprint: cert.publicKeyFingerprint,
    provisioner: { username: 'img21-0123456789abcdef-admin', email: 'admin@example.invalid' },
    viewer: { username: 'img21-0123456789abcdef-viewer', email: 'viewer@example.invalid' },
    writerVersion: '1',
    verifierVersion: '2',
    licenseSecretVersion: '1'.repeat(32),
    verifierBinding: null,
    verification: null,
    ...overrides,
  };
  const raw = JSON.stringify(m);
  return bindManifest(raw, digest(raw));
}
export const context = (kind: 'writer' | 'verifier', bound: BoundManifest): Invocation => ({
  functionVersion: kind === 'writer' ? bound.manifest.writerVersion : bound.manifest.verifierVersion,
  invokedFunctionArn: `arn:aws:lambda:${TARGET.region}:${TARGET.accountId}:function:fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}:${kind === 'writer' ? bound.manifest.writerVersion : bound.manifest.verifierVersion}`,
});
export function request(bound: BoundManifest, action: WriteRequest['action'], extra: Partial<WriteRequest> = {}) {
  return { runId: bound.manifest.runId, manifestHash: bound.hash, operationId: digest(randomUUID()), action, ...extra };
}
export class ControlMemory implements LiveImageControlStore {
  values = new Map<string, LiveImageControl>();
  writes: string[] = [];
  failReopen = false;
  async readControl(id: string) {
    return structuredClone(this.values.get(id) ?? null);
  }
  async compareAndSwap(id: string, old: any, next: LiveImageControl) {
    if (this.failReopen && next.enabled) throw Error('INJECTED_REOPEN_FAILURE');
    if ((this.values.get(id)?.revision ?? null) !== (old?.revision ?? null)) return false;
    this.writes.push(id);
    this.values.set(id, structuredClone(next));
    return true;
  }
}
export async function writerFixture() {
  const db = await createTestDb();
  await db.pg.exec(readFileSync(new URL('../../../packages/database/prisma/seed.sql', import.meta.url), 'utf8'));
  const bound = manifest(),
    control = new ControlMemory();
  const identities: Record<string, CognitoIdentity> = {};
  for (const who of ['provisioner', 'viewer'] as const)
    identities[who] = {
      ...bound.manifest[who],
      sub: randomUUID(),
      enabled: true,
      createdAtMs: NOW - 10000,
      groups: [who === 'provisioner' ? 'PlatformSuperAdmin' : 'CustomerViewer'],
      customerId: null,
    };
  let now = NOW;
  const deps: WriterDependencies = {
    client: withLiveImageAuthority(db.prisma, control),
    control,
    identity: async (name) => {
      const i = Object.values(identities).find((x) => x.username === name);
      if (!i) throw Error('NOT_FOUND');
      return structuredClone(i);
    },
    now: () => now,
  };
  const invoke = (event: unknown) => createControlledWriter(bound, deps)(event, context('writer', bound));
  const f = {
    ...db,
    bound,
    control,
    deps,
    identities,
    invoke,
    setNow: (n: number) => {
      now = n;
    },
    close: async () => {
      await db.prisma.$disconnect();
      await db.pg.close();
    },
  };
  return f;
}
export async function provision(f: Awaited<ReturnType<typeof writerFixture>>, bind = true) {
  const seeded = await f.invoke(request(f.bound, 'SEED_PROVISIONER'));
  if (seeded.status !== 'COMMITTED') throw Error('SEED_FAILED:' + JSON.stringify(seeded));
  const adminId = String(seeded.result!.userId);
  // These fixture writes model normal API/login state, never Writer operations.
  await f.prisma.user.update({ where: { id: adminId }, data: { status: 'ACTIVE' } });
  const customer = await f.prisma.customer.create({
    data: { name: f.bound.manifest.customerName, createdAt: new Date(NOW - 20000) },
  });
  const site = await f.prisma.site.create({
    data: { name: f.bound.manifest.siteName, customerId: customer.id, createdAt: new Date(NOW - 20000) },
  });
  const deviceId = randomUUID();
  await f.prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: f.bound.manifest.serialNumber,
      model: f.bound.manifest.model,
      hardwareVersion: 'local',
      manufacturer: 'LOCAL FIXTURE',
      manufactureDate: new Date(NOW),
      customerId: customer.id,
      siteId: site.id,
      lifecycleStatus: 'Active',
      createdAt: new Date(NOW - 10000),
      latestState: { create: { operationalStatus: 'Active', customerId: customer.id } },
      certificates: {
        create: {
          id: 'cert-local',
          fingerprint: cert.fingerprint,
          publicKeyFingerprint: cert.publicKeyFingerprint,
          certificatePem: pem,
          status: 'ACTIVE',
          notBefore: cert.notBefore,
          notAfter: cert.notAfter,
        },
      },
      assignments: {
        create: {
          customerId: customer.id,
          siteId: site.id,
          assignedBy: f.identities.provisioner!.sub,
          assignedAt: new Date(NOW - 10000),
        },
      },
    },
  });
  const onboarding = await f.prisma.onboardingRequest.create({
    data: {
      serialNumber: f.bound.manifest.serialNumber,
      csrPem: csr.csrPem,
      publicKeyFingerprint: cert.publicKeyFingerprint,
      submittedBy: f.identities.provisioner!.sub,
      reviewedBy: f.identities.provisioner!.sub,
      reviewedAt: new Date(NOW - 5000),
      status: 'APPROVED',
      model: f.bound.manifest.model,
      hardwareVersion: 'local',
      manufacturer: 'LOCAL',
      manufactureDate: new Date(NOW),
      createdAt: new Date(NOW - 20000),
    },
  });
  for (const [type, id, action] of [
    ['customer', customer.id, 'customer.create'],
    ['site', site.id, 'site.create'],
    ['device', deviceId, 'device.assignment.assign'],
    ['onboarding_request', onboarding.id, 'onboarding.request.approve'],
  ] as const)
    await f.prisma.auditLog.create({
      data: {
        objectType: type,
        objectId: id,
        action,
        actorId: f.identities.provisioner!.sub,
        result: 'SUCCESS',
        createdAt: new Date(NOW - 4000),
      },
    });
  const result = bind ? await f.invoke(request(f.bound, 'BIND_DEVICE', { deviceId })) : null;
  if (result && result.status !== 'COMMITTED') throw Error('BIND_FAILED:' + JSON.stringify(result));
  return { deviceId, customerId: customer.id, siteId: site.id, adminId };
}
export async function viewer(f: Awaited<ReturnType<typeof writerFixture>>, customerId: string) {
  f.identities.viewer!.customerId = customerId;
  const seeded = await f.invoke(request(f.bound, 'SEED_VIEWER'));
  if (seeded.status !== 'COMMITTED') throw Error('VIEWER_FAILED:' + JSON.stringify(seeded));
  const userId = String(seeded.result!.userId);
  await f.prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
  return userId;
}
