/**
 * AUTH-02 验收（PGlite 真实 PostgreSQL + 实际 migration.sql）：
 * 签发只存 Hash、一次一机序列号绑定、错误/过期/撤销/核销/跨序列号均拒绝。
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import { PrismaClient } from '@fdp/database';
import {
  hashOnboardingToken,
  issueOnboardingToken,
  markOnboardingTokenUsed,
  revokeOnboardingToken,
  tokenFingerprint,
  verifyOnboardingToken,
} from '../src/index.js';
import { expectAuthError } from './helpers.js';

const MIGRATION_SQL = readFileSync(
  new URL('../../database/prisma/migrations/20260826120000_init/migration.sql', import.meta.url),
  'utf8',
);

let pg: PGlite;
let prisma: InstanceType<typeof PrismaClient>;

const FUTURE = new Date('2027-01-01T00:00:00Z');

async function insertInventoryDevice(serialNumber: string): Promise<void> {
  await prisma.device.create({
    data: {
      id: `dev-${serialNumber}`,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01'),
      lifecycleStatus: 'PendingOnboarding',
    },
  });
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(MIGRATION_SQL);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

describe('签发与存储', () => {
  test('库存序列号可签发；数据库只保存散列，不出现明文', async () => {
    await insertInventoryDevice('SN-ISSUE-1');
    const { token, record } = await issueOnboardingToken(prisma, {
      serialNumber: 'SN-ISSUE-1',
      expiresAt: FUTURE,
    });
    assert.match(token, /^fdp_onb_[A-Za-z0-9_-]{43}$/);
    assert.equal(record.serialNumber, 'SN-ISSUE-1');

    const row = await prisma.onboardingToken.findFirst({ where: { id: record.id } });
    assert.isNotNull(row);
    const serialized = JSON.stringify(row);
    assert.notInclude(serialized, token, '数据库不得出现明文 Token');
    assert.equal(row?.tokenHash, hashOnboardingToken(token));
  });

  test('序列号不在设备库存 → 400 VALIDATION_FAILED', async () => {
    await expectAuthError(
      issueOnboardingToken(prisma, { serialNumber: 'SN-NOT-EXIST', expiresAt: FUTURE }),
      'VALIDATION_FAILED',
    );
  });
});

describe('校验链', () => {
  test('合法 Token + 绑定序列号 → 通过并返回指纹上下文', async () => {
    await insertInventoryDevice('SN-OK-1');
    const { token, record } = await issueOnboardingToken(prisma, { serialNumber: 'SN-OK-1', expiresAt: FUTURE });
    const ctx = await verifyOnboardingToken(prisma, token, 'SN-OK-1');
    assert.equal(ctx.tokenId, record.id);
    assert.equal(ctx.serialNumber, 'SN-OK-1');
    assert.match(ctx.tokenFingerprint, /^[0-9a-f]{16}$/);
    assert.notEqual(ctx.tokenFingerprint, token);
    assert.equal(ctx.tokenFingerprint, tokenFingerprint(token));
  });

  test('仅显式允许时可由 Token 绑定隐式定位序列号', async () => {
    await insertInventoryDevice('SN-IMPLICIT-1');
    const { token, record } = await issueOnboardingToken(prisma, {
      serialNumber: 'SN-IMPLICIT-1',
      expiresAt: FUTURE,
    });
    const ctx = await verifyOnboardingToken(prisma, token, undefined, { allowImplicitSerialNumber: true });
    assert.equal(ctx.tokenId, record.id);
    assert.equal(ctx.serialNumber, 'SN-IMPLICIT-1');
  });

  test('错误（未签发）Token → 401', async () => {
    await expectAuthError(
      verifyOnboardingToken(prisma, 'fdp_onb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'SN-OK-1'),
      'UNAUTHENTICATED',
    );
  });

  test('畸形 Token → 401；缺序列号 → 400', async () => {
    await expectAuthError(verifyOnboardingToken(prisma, 'not-a-token', 'SN-OK-1'), 'UNAUTHENTICATED');
    await expectAuthError(verifyOnboardingToken(prisma, undefined, 'SN-OK-1'), 'UNAUTHENTICATED');
    await expectAuthError(
      verifyOnboardingToken(prisma, 'fdp_onb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined),
      'VALIDATION_FAILED',
    );
  });

  test('过期 Token → 401', async () => {
    await insertInventoryDevice('SN-EXP-1');
    const { token } = await issueOnboardingToken(prisma, {
      serialNumber: 'SN-EXP-1',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    await expectAuthError(
      verifyOnboardingToken(prisma, token, 'SN-EXP-1', { now: new Date('2026-06-01T00:00:00Z') }),
      'UNAUTHENTICATED',
    );
  });

  test('撤销 Token → 401；撤销幂等', async () => {
    await insertInventoryDevice('SN-REV-1');
    const { token, record } = await issueOnboardingToken(prisma, { serialNumber: 'SN-REV-1', expiresAt: FUTURE });
    assert.isTrue(await revokeOnboardingToken(prisma, record.id, new Date()));
    assert.isFalse(await revokeOnboardingToken(prisma, record.id, new Date()), '重复撤销应幂等返回 false');
    await expectAuthError(verifyOnboardingToken(prisma, token, 'SN-REV-1'), 'UNAUTHENTICATED');
  });

  test('核销（一次一机）→ 401；并发安全（二次核销 false）', async () => {
    await insertInventoryDevice('SN-USED-1');
    const { token, record } = await issueOnboardingToken(prisma, { serialNumber: 'SN-USED-1', expiresAt: FUTURE });
    assert.isTrue(await markOnboardingTokenUsed(prisma, record.id, new Date()));
    assert.isFalse(await markOnboardingTokenUsed(prisma, record.id, new Date()));
    await expectAuthError(verifyOnboardingToken(prisma, token, 'SN-USED-1'), 'UNAUTHENTICATED');
  });

  test('跨序列号使用 → 401', async () => {
    await insertInventoryDevice('SN-BIND-A');
    await insertInventoryDevice('SN-BIND-B');
    const { token } = await issueOnboardingToken(prisma, { serialNumber: 'SN-BIND-A', expiresAt: FUTURE });
    await expectAuthError(verifyOnboardingToken(prisma, token, 'SN-BIND-B'), 'UNAUTHENTICATED');
  });
});
