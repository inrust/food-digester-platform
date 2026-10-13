import { assert, describe, test } from 'vitest';
import { aggregationWindow, eventTimeOf, summaryObservation } from '../src/runtime/summary-entry.js';
import { summaryOutputSha256 } from '../src/aggregation/worker.js';

describe('Summary EventBridge runtime', () => {
  test('业务关联保留自然事件和请求；缺事件不冒充自然调度，JSONB 排序不改变摘要', () => {
    const at = new Date('2026-10-13T12:00:00Z'),
      observe = () => {};
    const row = summaryObservation(
      {
        id: 'event-1',
        source: 'aws.events',
        time: at.toISOString(),
        resources: ['arn:aws:events:region:000000000000:rule/fdp-test-summary'],
      },
      at,
      { awsRequestId: 'request-1' },
      observe,
    );
    assert.equal(row.lambdaRequestId, 'request-1');
    assert.equal(row.eventId, 'event-1');
    assert.equal(row.ruleName, 'fdp-test-summary');
    assert.equal(row.source, 'aws.events');
    assert.equal(summaryObservation(undefined, at, undefined, observe).source, 'MANUAL_OR_UNRECOGNIZED');
    assert.equal(
      summaryOutputSha256({ metrics: { weight: { min: 1, max: 3, avg: 2 } }, sampleCount: 1 }),
      summaryOutputSha256({ sampleCount: 1, metrics: { weight: { avg: 2, max: 3, min: 1 } } }),
    );
    assert.notEqual(summaryOutputSha256({ sampleCount: 1 }), summaryOutputSha256({ sampleCount: 2 }));
  });
  test('按 UTC 当前小时结束点重算显式 lookback 窗口', () => {
    assert.deepEqual(aggregationWindow(new Date('2026-09-07T12:34:56.789Z'), 2), {
      from: new Date('2026-09-07T11:00:00.000Z'),
      to: new Date('2026-09-07T12:59:59.999Z'),
    });
  });

  test('非法 lookback 失败关闭', () => {
    for (const value of [0, 1.5, 745]) assert.throws(() => aggregationWindow(new Date(), value));
  });

  test('使用 EventBridge event time 作为窗口锚点，非法事件时间失败关闭', () => {
    assert.equal(
      eventTimeOf({ time: '2026-09-07T12:34:56.789Z' }, () => new Date(0)).toISOString(),
      '2026-09-07T12:34:56.789Z',
    );
    assert.throws(() => eventTimeOf({ time: 'not-a-date' }));
  });
});
