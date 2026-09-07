import { assert, describe, test } from 'vitest';
import { aggregationWindow, eventTimeOf } from '../src/runtime/summary-entry.js';

describe('Summary EventBridge runtime', () => {
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
