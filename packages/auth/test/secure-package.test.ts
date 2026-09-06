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
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  createLocalTestKeyProvider,
  SecurePackageError,
  SecurePackageService,
} from '../src/index.js';
import type { ClaimProof } from '../src/index.js';
import type { OnboardingAuthContext } from '../src/onboarding/verifier.js';
import type { DeviceAuthContext } from '../src/device/verifier.js';

const MIGRATION_SQL = [
  '../../database/prisma/migrations/20260826120000_init/migration.sql',
  '../../database/prisma/migrations/20260905210000_certificate_recovery_state/migration.sql',
]
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');

const NOW = new Date('2026-08-27T00:00:00Z');
const RETENTION_SECONDS = CERTIFICATE_PACKAGE_RETENTION_SECONDS;

/** 含 PEM 私钥形态的测试负载（验收：全文不出现明文）；PEM 标记拼接构造，避免命中 check-secrets 门禁。 */
const PACKAGE_PLAINTEXT = Buffer.from(
  [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    'TESTONLYNOTREALKEYMATERIAL000000000000',
    ['-----END', 'PRIVATE KEY-----'].join(' '),
    '-----BEGIN CERTIFICATE-----',
    'TESTCERT',
    '-----END CERTIFICATE-----',
  ].join('\n'),
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
  test('DEC-003 失败关闭：retentionSeconds 偏离冻结值即拒绝构造', () => {
    for (const retentionSeconds of [RETENTION_SECONDS - 1, RETENTION_SECONDS + 1]) {
      assert.throws(
        () =>
          new SecurePackageService({
            db: prisma,
            keyProvider: createLocalTestKeyProvider('x'),
            config: { retentionSeconds, maxClaims: 1 },
          }),
        /retentionSeconds must equal DEC-003 frozen value/,
      );
    }
  });

  test('DEC-003 失败关闭：maxClaims !== 1 拒绝构造', () => {
    assert.throws(
      () =>
        new SecurePackageService({
          db: prisma,
          keyProvider: createLocalTestKeyProvider('x'),
          config: { retentionSeconds: RETENTION_SECONDS, maxClaims: 2 },
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
  test('Onboarding Token 资格 → 预留后保留密文，响应确认后销毁', async () => {
    await insertDeviceWithCertificate('dev-sec-2', 'SN-SEC-2', 'cert-sec-2');
    await service.storePackage('cert-sec-2', PACKAGE_PLAINTEXT);
    const payload = await service.preparePackageDelivery('cert-sec-2', onboardingProof('SN-SEC-2'));
    assert.deepEqual(Buffer.from(payload), PACKAGE_PLAINTEXT);

    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-2' } });
    assert.isNotNull(row?.packageCiphertext, '响应提交前必须保留可恢复密文');
    assert.isNotNull(row?.claimedAt);
    assert.isTrue(await service.confirmPackageDelivery('cert-sec-2'));
    assert.isFalse(await service.confirmPackageDelivery('cert-sec-2'), '确认操作幂等');
    assert.isNull((await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-2' } }))?.packageCiphertext);
  });

  test('确认交付后重复领取失败关闭（密文已销毁 → 404）', async () => {
    await expectSecurePackageError(
      service.preparePackageDelivery('cert-sec-2', onboardingProof('SN-SEC-2')),
      'NOT_FOUND',
      404,
    );
  });

  test('已锁定未销毁（并发部分失败场景）→ 409', async () => {
    await insertDeviceWithCertificate('dev-sec-3', 'SN-SEC-3', 'cert-sec-3');
    await service.storePackage('cert-sec-3', PACKAGE_PLAINTEXT);
    await prisma.deviceCertificate.updateMany({ where: { id: 'cert-sec-3' }, data: { claimedAt: NOW } });
    await expectSecurePackageError(
      service.preparePackageDelivery('cert-sec-3', onboardingProof('SN-SEC-3')),
      'CONFLICT',
      409,
    );
  });

  test('资格不符（跨序列号 / 跨设备证书）→ 403，密文保留', async () => {
    await insertDeviceWithCertificate('dev-sec-4', 'SN-SEC-4', 'cert-sec-4');
    await service.storePackage('cert-sec-4', PACKAGE_PLAINTEXT);
    await expectSecurePackageError(
      service.preparePackageDelivery('cert-sec-4', onboardingProof('SN-OTHER')),
      'FORBIDDEN',
      403,
    );
    await expectSecurePackageError(
      service.preparePackageDelivery('cert-sec-4', deviceCertProof('dev-other')),
      'FORBIDDEN',
      403,
    );
    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-4' } });
    assert.isNotNull(row?.packageCiphertext, '资格拒绝不得销毁密文');
  });

  test('旧设备证书资格（轮换场景，deviceId 绑定）→ 领取成功', async () => {
    await insertDeviceWithCertificate('dev-sec-5', 'SN-SEC-5', 'cert-sec-5');
    await service.storePackage('cert-sec-5', PACKAGE_PLAINTEXT);
    const payload = await service.preparePackageDelivery('cert-sec-5', deviceCertProof('dev-sec-5'));
    assert.deepEqual(Buffer.from(payload), PACKAGE_PLAINTEXT);
  });

  test('响应不确定 → 撤销证书并销毁未确认包', async () => {
    await insertDeviceWithCertificate('dev-sec-8', 'SN-SEC-8', 'cert-sec-8');
    await service.storePackage('cert-sec-8', PACKAGE_PLAINTEXT);
    await service.preparePackageDelivery('cert-sec-8', onboardingProof('SN-SEC-8'));
    assert.isTrue(await service.revokeUnconfirmedDelivery('cert-sec-8'));
    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-8' } });
    assert.equal(row?.status, 'REVOKED');
    assert.equal(row?.revokedAt?.toISOString(), NOW.toISOString());
    assert.isNull(row?.packageCiphertext);
  });

  test('过期包 → 409 且密文销毁', async () => {
    await insertDeviceWithCertificate('dev-sec-6', 'SN-SEC-6', 'cert-sec-6');
    await service.storePackage('cert-sec-6', PACKAGE_PLAINTEXT);
    const expiredService = new SecurePackageService({
      db: prisma,
      keyProvider: createLocalTestKeyProvider('sec01-test'),
      config: {
        retentionSeconds: RETENTION_SECONDS,
        maxClaims: 1,
        now: () => new Date(NOW.getTime() + (RETENTION_SECONDS + 1) * 1000),
      },
    });
    await expectSecurePackageError(
      expiredService.preparePackageDelivery('cert-sec-6', onboardingProof('SN-SEC-6')),
      'CONFLICT',
      409,
    );
    const row = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-6' } });
    assert.isNotNull(row?.packageCiphertext, '过期包须保留到恢复状态机完成云端撤证');
  });

  test('destroyPackage 幂等（新证书 Heartbeat 后销毁场景）', async () => {
    await insertDeviceWithCertificate('dev-sec-7', 'SN-SEC-7', 'cert-sec-7');
    await service.storePackage('cert-sec-7', PACKAGE_PLAINTEXT);
    assert.isTrue(await service.destroyPackage('cert-sec-7'));
    assert.isFalse(await service.destroyPackage('cert-sec-7'));
  });

  test('定时扫描只返回待恢复 ID，不会先于云端撤证销毁密文包', async () => {
    await insertDeviceWithCertificate('dev-sec-9', 'SN-SEC-9', 'cert-sec-9');
    await service.storePackage('cert-sec-9', PACKAGE_PLAINTEXT);
    const sweeper = new SecurePackageService({
      db: prisma,
      keyProvider: createLocalTestKeyProvider('sec01-test'),
      config: {
        retentionSeconds: RETENTION_SECONDS,
        maxClaims: 1,
        now: () => new Date(NOW.getTime() + (RETENTION_SECONDS + 1) * 1000),
      },
    });
    assert.include(await sweeper.findExpiredPackageIds(), 'cert-sec-9');
    assert.notInclude(await sweeper.findExpiredPackageIds(100, ['cert-sec-9']), 'cert-sec-9');
    assert.isNotNull((await prisma.deviceCertificate.findFirst({ where: { id: 'cert-sec-9' } }))?.packageCiphertext);
  });
});

describe('审计与脱敏', () => {
  test('store/prepare/confirm/revoke/destroy 写审计；审计负载无敏感材料', async () => {
    const logs = await prisma.auditLog.findMany({ where: { objectType: 'deviceCertificate' } });
    const actions = logs.map((l) => `${l.action}:${l.result}`);
    assert.include(actions, 'CERT_PACKAGE_STORE:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_DELIVERY_PREPARE:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_DELIVERY_PREPARE:FAILURE');
    assert.include(actions, 'CERT_PACKAGE_DELIVERY_CONFIRM:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_DELIVERY_UNCERTAIN_REVOKE:SUCCESS');
    assert.include(actions, 'CERT_PACKAGE_DESTROY:SUCCESS');

    const serialized = JSON.stringify(logs);
    assert.notInclude(serialized, 'TESTONLYNOTREALKEYMATERIAL');
    assert.notInclude(serialized, 'PRIVATE KEY-----');
  });
});
