import { assert, describe, test, vi } from 'vitest';
import type { DbClient } from '@fdp/database';
import { createRetirementTimeoutLambdaHandler } from '../src/runtime/retirement-timeout-lambda.js';
import type { RetirementTimeoutEvaluator } from '../src/runtime/retirement-timeout-lambda.js';

describe('DEC-014 retirement timeout Lambda', () => {
  test('EventBridge 调用映射到 evaluator 且传入受控批次上限', async () => {
    const client = {} as DbClient;
    const expected = { examined: 2, completed: 1, skipped: 1, completedDeviceIds: ['device-1'] };
    const evaluator = vi.fn<RetirementTimeoutEvaluator>(async () => expected);
    const handler = createRetirementTimeoutLambdaHandler(client, { batchSize: 100, evaluator });

    assert.deepEqual(await handler(), expected);
    assert.equal(evaluator.mock.calls.length, 1);
    assert.equal(evaluator.mock.calls[0]?.[0], client);
    assert.deepEqual(evaluator.mock.calls[0]?.[1], { batchSize: 100 });
  });
});
