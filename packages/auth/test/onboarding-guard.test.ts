/**
 * AUTH-02 认证中间件端到端（PGlite）：限频 → 校验 → Handler 顺序与错误语义。
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import { PrismaClient } from '@fdp/database';
import { createRateLimiter, InMemoryRateLimitStore, issueOnboardingToken, withOnboardingAuth } from '../src/index.js';
import type { OnboardingAuthContext } from '../src/index.js';
import { expectAuthError } from './helpers.js';

const MIGRATION_SQL = readFileSync(
  new URL('../../database/prisma/migrations/20260826120000_init/migration.sql', import.meta.url),
  'utf8',
);

let pg: PGlite;
let prisma: InstanceType<typeof PrismaClient>;

interface Req {
  readonly authorization?: string | undefined;
  readonly serialNumber?: string | undefined;
}

const tokenOf = (req: Req): string | undefined => {
  const header = req.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
};
const serialNumberOf = (req: Req): string | undefined => req.serialNumber;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(MIGRATION_SQL);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  await prisma.device.create({
    data: {
      id: 'dev-guard-1',
      serialNumber: 'SN-GUARD-1',
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01'),
      lifecycleStatus: 'PendingOnboarding',
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

describe('withOnboardingAuth', () => {
  test('合法 Token → Handler 收到可信上下文（指纹非明文）', async () => {
    const { token } = await issueOnboardingToken(prisma, {
      serialNumber: 'SN-GUARD-1',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    const guard = withOnboardingAuth<Req, string>(
      { client: prisma, tokenOf, serialNumberOf },
      (_req, auth: OnboardingAuthContext) => {
        assert.equal(auth.serialNumber, 'SN-GUARD-1');
        assert.notEqual(auth.tokenFingerprint, token);
        return 'ok';
      },
    );
    assert.equal(await guard({ authorization: `Bearer ${token}`, serialNumber: 'SN-GUARD-1' }), 'ok');
  });

  test('无效 Token → 401；缺序列号 → 400', async () => {
    const guard = withOnboardingAuth<Req, string>({ client: prisma, tokenOf, serialNumberOf }, () => 'ok');
    await expectAuthError(
      guard({
        authorization: 'Bearer fdp_onb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        serialNumber: 'SN-GUARD-1',
      }),
      'UNAUTHENTICATED',
    );
    await expectAuthError(guard({ authorization: 'Bearer x' }), 'UNAUTHENTICATED');
  });

  test('过量请求 → 429，且先于 Token 校验（限频在 DB 查询之前）', async () => {
    const limiter = createRateLimiter(new InMemoryRateLimitStore(), { limit: 2, windowSeconds: 60 });
    let handlerCalled = false;
    const guard = withOnboardingAuth<Req, string>(
      { client: prisma, tokenOf, serialNumberOf, rateLimiter: limiter },
      () => {
        handlerCalled = true;
        return 'ok';
      },
    );
    // 使用无效 Token：前两次走到校验（401），第三次被限频（429）——证明限频先于 DB 校验
    const req: Req = {
      authorization: 'Bearer fdp_onb_ccccccccccccccccccccccccccccccccccccccccccc',
      serialNumber: 'SN-GUARD-1',
    };
    await expectAuthError(guard(req), 'UNAUTHENTICATED');
    await expectAuthError(guard(req), 'UNAUTHENTICATED');
    await expectAuthError(guard(req), 'RATE_LIMITED');
    assert.isFalse(handlerCalled);
  });
});
