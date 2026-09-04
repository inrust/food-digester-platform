/**
 * BE-ONB-01 Onboarding Request API 端到端测试（PGlite 真实 PostgreSQL + 实际 migration.sql）。
 *
 * 验收基准覆盖：
 * - 正向返回 requestId/PENDING（201）；
 * - 四类负向：字段非法（400）、序列号不存在（404）、已 Onboarded（409）、未认证（401）；
 * - 重复提交幂等返回原 request（200）；并发重复提交仅产生一条记录；
 * - 稳定错误码与 CT-05 目录一致（见 onboarding-contract-parity.test.ts）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { DbClient } from '@fdp/database';
import {
  createRateLimiter,
  generateOnboardingToken,
  hashOnboardingToken,
  InMemoryRateLimitStore,
  issueOnboardingToken,
} from '@fdp/auth';
import { createOnboardingRequestHandler, submitOnboardingRequest } from '../src/index.js';
import type { OnboardingHttpRequest, OnboardingHttpResponse } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const SERIALS = {
  positive: 'SN-ONB-OK',
  idempotent: 'SN-ONB-IDEM',
  concurrent: 'SN-ONB-RACE',
  timedOutRetry: 'SN-ONB-TIMEOUT-RETRY',
  onboarded: 'SN-ONB-DONE',
} as const;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  for (const [i, serial] of Object.values(SERIALS).entries()) {
    await prisma.device.create({
      data: {
        id: `dev-onb-${i}`,
        serialNumber: serial,
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01T00:00:00Z'),
        lifecycleStatus: serial === SERIALS.onboarded ? 'Onboarded' : 'PendingOnboarding',
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

/** 默认 Handler：高限频避免干扰业务断言。 */
function makeHandler() {
  return createOnboardingRequestHandler({
    client: prisma,
    rateLimiter: createRateLimiter(new InMemoryRateLimitStore(), { limit: 10_000, windowSeconds: 60 }, now),
    now,
  });
}

function makeReq(token: string | undefined, body: unknown, requestId = 'req-test'): OnboardingHttpRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    requestId,
  };
}

function validBody(serialNumber: string) {
  return {
    serialNumber,
    model: 'BNX-100',
    hardwareVersion: 'HW1.0',
    manufacturer: 'Hiddenjoy',
    manufactureDate: '2026-01-01',
  };
}

interface SuccessPayload {
  data: { requestId: string; status: string; serialNumber: string; createdAt: string };
  meta: { requestId: string; timestamp: string };
}

interface ErrorPayload {
  error: { code: string; message: string; requestId: string };
}

async function issueToken(serialNumber: string): Promise<string> {
  const { token } = await issueOnboardingToken(prisma, {
    serialNumber,
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  });
  return token;
}

/** 绕过签发校验直接落库 Token（用于库存不存在等边界场景）。 */
async function plantToken(serialNumber: string): Promise<string> {
  const token = generateOnboardingToken();
  await prisma.onboardingToken.create({
    data: {
      tokenHash: hashOnboardingToken(token),
      serialNumber,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  return token;
}

async function requestCount(serialNumber: string): Promise<number> {
  return prisma.onboardingRequest.count({ where: { serialNumber } });
}

describe('POST /api/v1/device/onboarding/request', () => {
  test('正向：合法 Token + 合法字段 → 201，返回 requestId/PENDING，落库一条 PENDING 记录', async () => {
    const token = await issueToken(SERIALS.positive);
    const handler = makeHandler();
    const res = await handler(makeReq(token, validBody(SERIALS.positive), 'req-positive'));

    assert.equal(res.status, 201);
    const body = res.body as SuccessPayload;
    assert.equal(body.data.status, 'PENDING');
    assert.equal(body.data.serialNumber, SERIALS.positive);
    assert.ok(body.data.requestId.length > 0);
    assert.equal(body.meta.requestId, 'req-positive');
    assert.match(body.meta.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    assert.match(body.data.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const rows = await prisma.onboardingRequest.findMany({ where: { serialNumber: SERIALS.positive } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, body.data.requestId);
    assert.equal(rows[0]?.status, 'PENDING');
  });

  test('幂等：重复提交返回 200 与原 requestId，不覆盖原申请、不产生新记录', async () => {
    const token = await issueToken(SERIALS.idempotent);
    const handler = makeHandler();
    const first = await handler(makeReq(token, validBody(SERIALS.idempotent)));
    assert.equal(first.status, 201);
    const second = await handler(makeReq(token, { ...validBody(SERIALS.idempotent), manufacturer: 'Changed' }));

    assert.equal(second.status, 200);
    assert.equal((first.body as SuccessPayload).data.requestId, (second.body as SuccessPayload).data.requestId);
    assert.equal(await requestCount(SERIALS.idempotent), 1);
    const row = await prisma.onboardingRequest.findFirst({ where: { serialNumber: SERIALS.idempotent } });
    assert.equal(row?.manufacturer, 'Hiddenjoy');
  });

  test('并发重复提交：5 个并发请求同一 requestId，全库仅一条记录', async () => {
    const token = await issueToken(SERIALS.concurrent);
    const handler = makeHandler();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => handler(makeReq(token, validBody(SERIALS.concurrent), `req-c-${i}`))),
    );
    const ids = new Set(results.map((r: OnboardingHttpResponse) => (r.body as SuccessPayload).data.requestId));
    assert.equal(ids.size, 1);
    for (const res of results) assert.ok(res.status === 200 || res.status === 201);
    assert.equal(await requestCount(SERIALS.concurrent), 1);
  });

  test('DEC-017：TIMED_OUT 旧申请不复用，必须用新 Token 创建新 PENDING 申请', async () => {
    const oldToken = await issueToken(SERIALS.timedOutRetry);
    const handler = makeHandler();
    const first = await handler(makeReq(oldToken, validBody(SERIALS.timedOutRetry)));
    const firstId = (first.body as SuccessPayload).data.requestId;
    await prisma.onboardingRequest.update({
      where: { id: firstId },
      data: { status: 'TIMED_OUT', rejectReason: 'ONBOARDING_TIMEOUT', timedOutAt: NOW },
    });

    const newToken = await issueToken(SERIALS.timedOutRetry);
    const retry = await handler(makeReq(newToken, validBody(SERIALS.timedOutRetry)));
    assert.equal(retry.status, 201);
    assert.notEqual((retry.body as SuccessPayload).data.requestId, firstId);
    assert.equal(await requestCount(SERIALS.timedOutRetry), 2);
    assert.equal(
      await prisma.onboardingRequest.count({ where: { serialNumber: SERIALS.timedOutRetry, status: 'PENDING' } }),
      1,
    );
  });

  test('并发唯一冲突兜底：create 命中 P2002 时回读胜出记录幂等返回（stub 确定性复现）', async () => {
    const winner = {
      id: 'req-winner',
      tokenId: 'tok-1',
      serialNumber: 'SN-RACE',
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: NOW,
      status: 'PENDING',
      createdAt: NOW,
    };
    let findCount = 0;
    const stubClient = {
      onboardingRequest: {
        findFirst: () => {
          findCount += 1;
          // 第一次（重放检查）无记录；第二次（冲突回读）返回胜出记录
          return Promise.resolve(findCount === 1 ? null : winner);
        },
        create: () => Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' })),
      },
      device: {
        findFirst: () => Promise.resolve({ id: 'dev-race', lifecycleStatus: 'PendingOnboarding' }),
      },
    };
    const result = await submitOnboardingRequest(
      stubClient as unknown as DbClient,
      { tokenId: 'tok-1', serialNumber: 'SN-RACE', tokenFingerprint: 'fp' },
      validBody('SN-RACE'),
      { now },
    );
    assert.equal(result.requestId, 'req-winner');
    assert.isTrue(result.replayed);
  });

  test('负向-字段非法：缺字段/非法日期/未来日期/非法序列号格式 → 400 VALIDATION_FAILED', async () => {
    const token = await issueToken(SERIALS.positive);
    const handler = makeHandler();
    const cases: unknown[] = [
      { ...validBody(SERIALS.positive), model: undefined },
      { ...validBody(SERIALS.positive), hardwareVersion: '' },
      { ...validBody(SERIALS.positive), manufactureDate: '2026/01/01' },
      { ...validBody(SERIALS.positive), manufactureDate: '2026-02-30' },
      { ...validBody(SERIALS.positive), manufactureDate: '2026-12-31' }, // 晚于注入时钟 2026-08-27
      'not-an-object',
    ];
    for (const body of cases) {
      const res = await handler(makeReq(token, body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as ErrorPayload).error.code, 'VALIDATION_FAILED');
      assert.equal((res.body as ErrorPayload).error.requestId, 'req-test');
    }
    // 非法序列号格式：直接落库一个绑定畸形序列号的 Token，使绑定校验通过、DTO 校验触发
    const badSerialToken = await plantToken('BAD SERIAL!');
    const res = await handler(makeReq(badSerialToken, validBody('BAD SERIAL!')));
    assert.equal(res.status, 400);
    assert.equal((res.body as ErrorPayload).error.code, 'VALIDATION_FAILED');
  });

  test('负向-序列号不存在：库存中无此序列号 → 404 NOT_FOUND', async () => {
    const token = await plantToken('SN-GHOST');
    const handler = makeHandler();
    const res = await handler(makeReq(token, validBody('SN-GHOST')));
    assert.equal(res.status, 404);
    assert.equal((res.body as ErrorPayload).error.code, 'NOT_FOUND');
  });

  test('负向-已 Onboarded：设备不在 PendingOnboarding → 409 DEVICE_STATE_NOT_ALLOWED', async () => {
    const token = await issueToken(SERIALS.onboarded);
    const handler = makeHandler();
    const res = await handler(makeReq(token, validBody(SERIALS.onboarded)));
    assert.equal(res.status, 409);
    assert.equal((res.body as ErrorPayload).error.code, 'DEVICE_STATE_NOT_ALLOWED');
  });

  test('负向-未认证：缺 Token/伪造 Token/跨序列号 → 401 UNAUTHENTICATED', async () => {
    const token = await issueToken(SERIALS.positive);
    const handler = makeHandler();
    // 缺 Token
    let res = await handler(makeReq(undefined, validBody(SERIALS.positive)));
    assert.equal(res.status, 401);
    assert.equal((res.body as ErrorPayload).error.code, 'UNAUTHENTICATED');
    // 伪造 Token
    res = await handler(makeReq(`fdp_onb_${'a'.repeat(43)}`, validBody(SERIALS.positive)));
    assert.equal(res.status, 401);
    // 跨序列号：SN-ONB-OK 的 Token 提交 SN-ONB-DONE 的申请
    res = await handler(makeReq(token, validBody(SERIALS.onboarded)));
    assert.equal(res.status, 401);
  });

  test('防御纵深：绕过 Guard 直连 Service，序列号与凭证不一致 → 400 VALIDATION_FAILED', async () => {
    try {
      await submitOnboardingRequest(
        prisma,
        { tokenId: 'tok-x', serialNumber: SERIALS.positive, tokenFingerprint: 'fp' },
        validBody('SN-OTHER'),
        { now },
      );
      assert.fail('应抛出 VALIDATION_FAILED');
    } catch (err) {
      assert.equal((err as { code?: string }).code, 'VALIDATION_FAILED');
    }
  });
});
