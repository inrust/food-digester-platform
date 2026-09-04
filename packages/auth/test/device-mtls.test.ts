/**
 * AUTH-03 验收（PGlite 真实 PostgreSQL + 实际 migration.sql）：
 * 有效证书通过；同 CA 未登记、撤销/过期/未激活、跨 deviceId 均拒绝；Retired 仅 Sync 限时例外。
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem, verifyDeviceCertificate, withDeviceAuth } from '../src/index.js';
import type { ClientCertIdentity, DeviceAuthContext } from '../src/index.js';
import { expectAuthError } from './helpers.js';

// 生成的 Prisma Client 以最新 Schema 为准：按序应用全部迁移（与 cloud-api 测试同策略）
const MIGRATIONS_DIR = new URL('../../database/prisma/migrations/', import.meta.url);
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((entry) => /^\d{14}_[a-z0-9_]+$/.test(entry))
  .sort()
  .map((entry) => readFileSync(fileURLToPath(new URL(`${entry}/migration.sql`, MIGRATIONS_DIR)), 'utf8'))
  .join('\n');

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2030-01-01T00:00:00Z');
const NOW = new Date('2026-08-27T00:00:00Z');

/** 构造测试 PEM（内容为确定性伪 DER；校验只关心 PEM→DER→SHA-256 指纹）。 */
function makePem(seed: string): string {
  const b64 = Buffer.from(`fake-der-bytes-${seed}`, 'utf8').toString('base64');
  const lines = (b64.match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

const identityOf = (pem: string): ClientCertIdentity => ({ clientCertPem: pem });

let pg: PGlite;
let prisma: InstanceType<typeof PrismaClient>;

async function insertDevice(id: string, lifecycleStatus: string, customerId?: string): Promise<void> {
  await prisma.device.create({
    data: {
      id,
      serialNumber: `SN-${id}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01'),
      lifecycleStatus,
      ...(customerId ? { customerId } : {}),
    },
  });
}

interface CertSeed {
  status?: string;
  notBefore?: Date;
  notAfter?: Date;
  revokedAt?: Date;
}

async function insertCertificate(
  certId: string,
  deviceId: string,
  pemSeed: string,
  seed: CertSeed = {},
): Promise<string> {
  const pem = makePem(pemSeed);
  const fingerprint = certificateFingerprintFromPem(pem);
  await prisma.deviceCertificate.create({
    data: {
      id: certId,
      deviceId,
      fingerprint,
      status: seed.status ?? 'ACTIVE',
      notBefore: seed.notBefore ?? PAST,
      notAfter: seed.notAfter ?? FUTURE,
      ...(seed.revokedAt ? { revokedAt: seed.revokedAt } : {}),
    },
  });
  return pem;
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(MIGRATION_SQL);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  await prisma.customer.create({ data: { id: 'cust-a', name: '客户A' } });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

describe('verifyDeviceCertificate 白名单校验', () => {
  test('有效证书通过并注入 device/customer context', async () => {
    await insertDevice('dev-active', 'Active', 'cust-a');
    const pem = await insertCertificate('cert-active', 'dev-active', 'active');
    const ctx = await verifyDeviceCertificate(prisma, identityOf(pem), { now: NOW });
    assert.equal(ctx.deviceId, 'dev-active');
    assert.equal(ctx.certificateId, 'cert-active');
    assert.equal(ctx.customerId, 'cust-a');
    assert.equal(ctx.deviceLifecycleStatus, 'Active');
    assert.match(ctx.certificateFingerprint, /^[0-9a-f]{64}$/);
  });

  test('同 CA 未登记证书（指纹不在白名单）→ 401', async () => {
    await expectAuthError(
      verifyDeviceCertificate(prisma, identityOf(makePem('unregistered')), { now: NOW }),
      'UNAUTHENTICATED',
    );
  });

  test('REVOKED / EXPIRED / PENDING_CLAIM 状态均 → 401', async () => {
    await insertDevice('dev-status', 'Active');
    const revoked = await insertCertificate('cert-revoked', 'dev-status', 'revoked', { status: 'REVOKED' });
    const expired = await insertCertificate('cert-expired', 'dev-status', 'expired', { status: 'EXPIRED' });
    const pending = await insertCertificate('cert-pending', 'dev-status', 'pending', { status: 'PENDING_CLAIM' });
    for (const pem of [revoked, expired, pending]) {
      await expectAuthError(verifyDeviceCertificate(prisma, identityOf(pem), { now: NOW }), 'UNAUTHENTICATED');
    }
  });

  test('状态 ACTIVE 但有效期外（过期/未生效）→ 401', async () => {
    await insertDevice('dev-validity', 'Active');
    const expiredWindow = await insertCertificate('cert-window-expired', 'dev-validity', 'wexp', {
      notBefore: PAST,
      notAfter: new Date('2026-01-01T00:00:00Z'),
    });
    const notYetValid = await insertCertificate('cert-window-future', 'dev-validity', 'wfuture', {
      notBefore: new Date('2027-01-01T00:00:00Z'),
      notAfter: FUTURE,
    });
    await expectAuthError(verifyDeviceCertificate(prisma, identityOf(expiredWindow), { now: NOW }), 'UNAUTHENTICATED');
    await expectAuthError(verifyDeviceCertificate(prisma, identityOf(notYetValid), { now: NOW }), 'UNAUTHENTICATED');
  });

  test('数据不一致防线：revokedAt 置位即使状态 ACTIVE 也 → 401', async () => {
    await insertDevice('dev-inconsistent', 'Active');
    const pem = await insertCertificate('cert-inconsistent', 'dev-inconsistent', 'inconsistent', {
      revokedAt: new Date('2026-06-01T00:00:00Z'),
    });
    await expectAuthError(verifyDeviceCertificate(prisma, identityOf(pem), { now: NOW }), 'UNAUTHENTICATED');
  });

  test('请求其他 deviceId → 403', async () => {
    await insertDevice('dev-owner', 'Active');
    const pem = await insertCertificate('cert-owner', 'dev-owner', 'owner');
    await expectAuthError(
      verifyDeviceCertificate(prisma, identityOf(pem), { requestedDeviceId: 'dev-other', now: NOW }),
      'FORBIDDEN',
    );
  });

  test('Retired 默认 → 403；仅窗口内 PENDING_CONFIRMATION 可显式申请 Sync 能力', async () => {
    await insertDevice('dev-retired', 'Retired');
    const retiredPem = await insertCertificate('cert-retired', 'dev-retired', 'retired');
    await expectAuthError(verifyDeviceCertificate(prisma, identityOf(retiredPem), { now: NOW }), 'FORBIDDEN');

    await prisma.deviceRetirement.create({
      data: {
        deviceId: 'dev-retired',
        reason: 'retire',
        initiatedBy: 'admin',
        initiatedAt: new Date(NOW.getTime() - 71 * 60 * 60 * 1000),
      },
    });
    const syncCtx = await verifyDeviceCertificate(prisma, identityOf(retiredPem), {
      now: NOW,
      retiredAccess: 'SYNC',
    });
    assert.equal(syncCtx.deviceLifecycleStatus, 'Retired');
    await expectAuthError(
      verifyDeviceCertificate(prisma, identityOf(retiredPem), {
        now: new Date(NOW.getTime() + 60 * 60 * 1000),
        retiredAccess: 'SYNC',
      }),
      'FORBIDDEN',
    );

    await insertDevice('dev-suspended', 'Suspended');
    const suspendedPem = await insertCertificate('cert-suspended', 'dev-suspended', 'suspended');
    const ctx = await verifyDeviceCertificate(prisma, identityOf(suspendedPem), { now: NOW });
    assert.equal(ctx.deviceLifecycleStatus, 'Suspended');
  });

  test('缺失/畸形证书上下文 → 401', async () => {
    await expectAuthError(verifyDeviceCertificate(prisma, undefined, { now: NOW }), 'UNAUTHENTICATED');
    await expectAuthError(verifyDeviceCertificate(prisma, {}, { now: NOW }), 'UNAUTHENTICATED');
    await expectAuthError(
      verifyDeviceCertificate(prisma, { clientCertPem: 'not-a-pem' }, { now: NOW }),
      'UNAUTHENTICATED',
    );
  });
});

describe('withDeviceAuth 中间件', () => {
  interface Req {
    readonly identity?: ClientCertIdentity | undefined;
    readonly deviceId?: string | undefined;
  }
  const identityOfReq = (req: Req): ClientCertIdentity | undefined => req.identity;
  const deviceIdOf = (req: Req): string | undefined => req.deviceId;

  test('有效证书 + 匹配 deviceId → Handler 收到上下文', async () => {
    await insertDevice('dev-guard', 'Active', 'cust-a');
    const pem = await insertCertificate('cert-guard', 'dev-guard', 'guard');
    const guard = withDeviceAuth<Req, string>(
      { client: prisma, identityOf: identityOfReq, deviceIdOf, now: () => NOW },
      (_req, auth: DeviceAuthContext) => {
        assert.equal(auth.deviceId, 'dev-guard');
        assert.equal(auth.customerId, 'cust-a');
        return 'ok';
      },
    );
    assert.equal(await guard({ identity: identityOf(pem), deviceId: 'dev-guard' }), 'ok');
  });

  test('deviceId 不匹配 → 403，不进入 Handler', async () => {
    const pem = await insertCertificate('cert-guard2', 'dev-guard', 'guard2');
    let called = false;
    const guard = withDeviceAuth<Req, void>(
      { client: prisma, identityOf: identityOfReq, deviceIdOf, now: () => NOW },
      () => {
        called = true;
      },
    );
    await expectAuthError(guard({ identity: identityOf(pem), deviceId: 'dev-other' }), 'FORBIDDEN');
    assert.isFalse(called);
  });

  test('缺失证书上下文 → 401', async () => {
    const guard = withDeviceAuth<Req, string>(
      { client: prisma, identityOf: identityOfReq, deviceIdOf, now: () => NOW },
      () => 'ok',
    );
    await expectAuthError(guard({ deviceId: 'dev-guard' }), 'UNAUTHENTICATED');
  });
});
