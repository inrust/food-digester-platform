import { assert, describe, test, vi } from 'vitest';
import type { DbClient } from '@fdp/database';
import { createRetirementTimeoutLambdaHandler } from '../src/runtime/retirement-timeout-lambda.js';
import type { RetirementTimeoutEvaluator } from '../src/runtime/retirement-timeout-lambda.js';

const service = vi.hoisted(() => ({ evaluateRetirementTimeouts: vi.fn() }));
vi.mock('../src/admin/device-retirement/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/admin/device-retirement/service.js')>()),
  evaluateRetirementTimeouts: service.evaluateRetirementTimeouts,
}));

describe('DEC-014 retirement timeout Lambda', () => {
  test('EventBridge 调用映射到 evaluator 且传入受控批次上限', async () => {
    const client = {} as DbClient;
    const expected = {
      examined: 2,
      completed: 1,
      skipped: 1,
      completedDeviceIds: ['device-1'],
      iotRevocations: { examined: 1, completed: 1, failed: 0, skipped: 0 },
    };
    const evaluator = vi.fn<RetirementTimeoutEvaluator>(async () => expected);
    const handler = createRetirementTimeoutLambdaHandler(client, { batchSize: 100, evaluator });

    assert.deepEqual(await handler(), expected);
    assert.equal(evaluator.mock.calls.length, 1);
    assert.equal(evaluator.mock.calls[0]?.[0], client);
    assert.deepEqual(evaluator.mock.calls[0]?.[1], { batchSize: 100 });
  });

  test('缺省生产路径调用 evaluateRetirementTimeouts Service', async () => {
    const client = {} as DbClient;
    const expected = {
      examined: 1,
      completed: 1,
      skipped: 0,
      completedDeviceIds: ['device-prod'],
      iotRevocations: { examined: 0, completed: 0, failed: 0, skipped: 0 },
    };
    service.evaluateRetirementTimeouts.mockResolvedValueOnce(expected);

    const handler = createRetirementTimeoutLambdaHandler(client, { batchSize: 25 });
    assert.deepEqual(await handler(), expected);
    assert.equal(service.evaluateRetirementTimeouts.mock.calls[0]?.[0], client);
    assert.deepEqual(service.evaluateRetirementTimeouts.mock.calls[0]?.[1], { batchSize: 25 });
  });
});
