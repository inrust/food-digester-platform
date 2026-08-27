/**
 * SEC-01 证书包服务验收（PGlite 真实 PostgreSQL + 实际 migration.sql）：
 * 无明文落库、一次性领取、领取资格绑定、过期销毁、审计无敏感内容。
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import { PrismaClient } from '@fdp/database';
import { createLocalTestKeyProvider, SecurePackageError, SecurePackageService } from '../src/index.js';
import type { ClaimProof } from '../src/index.js';
import type { OnboardingAuthContext } from '../src/onboarding/verifier.js';
import type { DeviceAuthContext } from '../src/device/verifier.js';

const MIGRATION_SQL = readFileSync(
  new URL('../../database/prisma/migrations/20260826120000_init/migration.sql', import.meta.url),
  'utf8',
);

const NOW = new Date('2026-08-27T00:00:00Z');
const RETENTION_SECONDS = 3600;

/** 含 PEM 私钥形态的测试负载（验收：全文不出现明文）。 */
const PACKAGE_PLAINTEXT = Buffer.from(
  '-----BEGIN PRIVATE KEY-----\nTESTONLYNOTREALKEYMATERIAL000000000000\n-----END PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----\nTESTCERT\n-----END CERTIFICATE-----',
  'utf8',
);

let pg: PGlite;
let prisma: InstanceType<typeof PrismaClient>;
let service: SecurePackageService;

function onboardingProof(serialNumber: string): ClaimProof {
  const context: OnboardingAuthContext = {
    tokenId: 'token-1',
    serialNumber,
    tokenFingerprint: 'fp0123456789abcd',
  };
  return { kind: 'onboardingToken', context };
}

function deviceCertProof(deviceId: string): ClaimProof {
  const context: DeviceAuthContext = {
    deviceId,
    certificateId: 'cert-old',
    certificateFingerprint: 'a'.repeat(64),
    customerId: null,
    siteId: null,
    deviceLifecycleStatus: 'Active',
  };
  return { kind: 'deviceCertificate', context };
}

async function insertDeviceWithCertificate(
  deviceId: string,
  serialNumber: string,
  certificateId: string,
): Promise<void> {
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01'),
      lifecycleStatus: 'Onboarded',
    },
  });
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: `${certificateId}-fingerprint`,
      status: 'PENDING_CLAIM',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2030-01-01T00:00:00Z'),
    },
  });
}

async function expectSecurePackageError(
  promise: Promise<unknown>,
  code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'CORRUPT_PACKAGE',
  httpStatus: number,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.instanceOf(err, SecurePackageError);
    assert.equal((err as SecurePackageError).code, code);
    assert.equal((err as SecurePackageError).httpStatus, httpStatus);
    return;
  }
  assert.fail(`应抛出 SecurePackageError(${code})，但实际成功返回`);
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(MIGRATION_SQL);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  service = new SecurePackageService({
    db: prisma,
    keyProvider: createLocalTestKeyProvider('sec01-test'),
    config: { retentionSeconds: RETENTION_SECONDS, maxClaims: 1, now: () => NOW },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

describe('配置与存储', () => {
  test('DEC-003 失败关闭：maxClaims !== 1 拒绝构造', () => {
    assert.throws(
      () =>
        new SecurePackageService({
          db: prisma,
          keyProvider: createLocalTestKeyProvider('x'),
          config: { retentionSeconds: 60, maxClaims: 2 },
        }),
      /maxClaims must be 1/,
    );
  });

  test('存储即加密：库中无明文，有效期按 retentionSeconds 推导', async () => {
    await insertDeviceWithCertificate('dev-sec-1', 'SN-SEC-1', 'cert-sec-1');
    const { expiresAt } = await service.storePackage('cert-sec-1', PACKAGE_PLAINTEXT);
    assert.equal(expiresAt.getTime(), NOW.getTime() + RETENTION_SECONDS * 1000);

    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-1' } });
    assert.isNotNull(row?.packageCiphertext);
    const raw = Buffer.from(row!.packageCiphertext as Uint8Array).toString('hex');
    assert.notInclude(raw, PACKAGE_PLAINTEXT.toString('hex'), '密文不得包含明文');
    assert.notInclude(raw, Buffer.from('TESTONLYNOTREALKEYMATERIAL000000000000').toString('hex'));
    assert.equal(row?.packageKmsKeyId, 'local-test-key');
  });

  test('不存在证书存储 → 404', async () => {
    await expectSecurePackageError(service.storePackage('cert-none', PACKAGE_PLAINTEXT), 'NOT_FOUND', 404);
  });
});

describe('一次性领取', () => {
  test('Onboarding Token 资格（序列号绑定）→ 领取成功并销毁密文', async () => {
    await insertDeviceWithCertificate('dev-sec-2', 'SN-SEC-2', 'cert-sec-2');
    await service.storePackage('cert-sec-2', PACKAGE_PLAINTEXT);
    const payload = await service.claimPackage('cert-sec-2', onboardingProof('SN-SEC-2'));
    assert.deepEqual(Buffer.from(payload), PACKAGE_PLAINTEXT);

    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-2' } });
    assert.isNull(row?.packageCiphertext, '领取成功后密文必须销毁');
    assert.isNotNull(row?.claimedAt);
  });

  test('重复领取失败关闭（密文已销毁 → 404）', async () => {
    await expectSecurePackageError(service.claimPackage('cert-sec-2', onboardingProof('SN-SEC-2')), 'NOT_FOUND', 404);
  });

  test('已锁定未销毁（并发部分失败场景）→ 409', async () => {
    await insertDeviceWithCertificate('dev-sec-3', 'SN-SEC-3', 'cert-sec-3');
    await service.storePackage('cert-sec-3', PACKAGE_PLAINTEXT);
    await prisma.deviceCertificate.updateMany({ where: { id: 'cert-sec-3' }, data: { claimedAt: NOW } });
    await expectSecurePackageError(service.claimPackage('cert-sec-3', onboardingProof('SN-SEC-3')), 'CONFLICT', 409);
  });

  test('资格不符（跨序列号 / 跨设备证书）→ 403，密文保留', async () => {
    await insertDeviceWithCertificate('dev-sec-4', 'SN-SEC-4', 'cert-sec-4');
    await service.storePackage('cert-sec-4', PACKAGE_PLAINTEXT);
    await expectSecurePackageError(service.claimPackage('cert-sec-4', onboardingProof('SN-OTHER')), 'FORBIDDEN', 403);
    await expectSecurePackageError(service.claimPackage('cert-sec-4', deviceCertProof('dev-other')), 'FORBIDDEN', 403);
    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-4' } });
    assert.isNotNull(row?.packageCiphertext, '资格拒绝不得销毁密文');
  });

  test('旧设备证书资格（轮换场景，deviceId 绑定）→ 领取成功', async () => {
    await insertDeviceWithCertificate('dev-sec-5', 'SN-SEC-5', 'cert-sec-5');
    await service.storePackage('cert-sec-5', PACKAGE_PLAINTEXT);
    const payload = await service.claimPackage('cert-sec-5', deviceCertProof('dev-sec-5'));
    assert.deepEqual(Buffer.from(payload), PACKAGE_PLAINTEXT);
  });

  test('过期包 → 409 且密文销毁', async () => {
    await insertDeviceWithCertificate('dev-sec-6', 'SN-SEC-6', 'cert-sec-6');
    await service.storePackage('cert-sec-6', PACKAGE_PLAINTEXT);
    const expiredService = new SecurePackageService({
      db: prisma,
      keyProvider: createLocalTestKeyProvider('sec01-test'),
      config: { retentionSeconds: RETENTION_SECONDS, maxClaims: 1, now: () => new Date(NOW.getTime() + 7200_000) },
    });
    await expectSecurePackageError(
      expiredService.claimPackage('cert-sec-6', onboardingProof('SN-SEC-6')),
      'CONFLICT',
      409,
    );
    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-6' } });
    assert.isNull(row?.packageCiphertext, '过期包必须销毁');
  });

  test('destroyPackage 幂等（新证书 Heartbeat 后销毁场景）', async () => {
    await insertDeviceWithCertificate('dev-sec-7', 'SN-SEC-7', 'cert-sec-7');
    await service.storePackage('cert-sec-7', PACKAGE_PLAINTEXT);
    assert.isTrue(await service.destroyPackage('cert-sec-7'));
    assert.isFalse(await service.destroyPackage('cert-sec-7'));
  });
});

describe('审计与脱敏', () => {
  test('store/claim/destroy 写审计；审计负载无明文、无密钥材料', async () => {
    const logs = await prisma.auditLog.findMany({ where: { objectType: 'deviceCertificate' } });
    const actions = logs.map((l) => `${l.action}:${l.result}`);
    assert.include(actions, 'CERT_PACKAGE_STORE:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_CLAIM:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_CLAIM:FAILURE');
    assert.include(actions, 'CERT_PACKAGE_DESTROY:SUCCESS');

    const serialized = JSON.stringify(logs);
    assert.notInclude(serialized, 'TESTONLYNOTREALKEYMATERIAL');
    assert.notInclude(serialized, 'PRIVATE KEY-----');
  });
});
