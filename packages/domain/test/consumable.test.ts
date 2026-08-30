/**
 * BE-CNS-01 耗材领域规则单测：字典映射、百分比校验、乱序防护、stale 派生、策略一致性。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, describe, test } from 'vitest';
import {
  CONSUMABLE_STALE_AFTER_MS,
  CONSUMABLE_TYPES,
  ConsumableError,
  assertConsumableRequestTransition,
  assertKnownConsumableType,
  assertRemainingPercent,
  decideProjectionUpdate,
  isConsumableStale,
  mapConsumableRawName,
} from '../src/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConsumableError);
    return err.code;
  }
  assert.fail('should throw ConsumableError');
}

describe('字典映射（DEC-008）', () => {
  test('原型两种耗材列稳定映射且不混用', () => {
    for (const raw of ['碳包', '碳滤网', 'carbon_filter', 'Carbon Filter', ' CARBON ']) {
      assert.equal(mapConsumableRawName(raw), 'CARBON_FILTER');
    }
    for (const raw of ['活性菌', '添加剂', 'bio_additive', 'Bio Additive', ' BIO ']) {
      assert.equal(mapConsumableRawName(raw), 'BIO_ADDITIVE');
    }
  });

  test('未知名称失败关闭', () => {
    assert.equal(
      codeOf(() => mapConsumableRawName('催化剂')),
      'UNKNOWN_CONSUMABLE_TYPE',
    );
    assert.equal(
      codeOf(() => mapConsumableRawName('')),
      'UNKNOWN_CONSUMABLE_TYPE',
    );
  });

  test('类型代码与 DEC-008 策略 JSON 一致（封闭集合）', () => {
    const policy = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../contracts/domain/consumables-policy.json', import.meta.url)),
        'utf8',
      ),
    ) as { types: { codes: string[] } };
    assert.deepEqual([...CONSUMABLE_TYPES].sort(), [...policy.types.codes].sort());
  });
});

describe('百分比校验', () => {
  test('0~100 整数或 null 合法；越界/非整数拒绝', () => {
    assert.doesNotThrow(() => assertRemainingPercent(null));
    assert.doesNotThrow(() => assertRemainingPercent(0));
    assert.doesNotThrow(() => assertRemainingPercent(100));
    assert.equal(
      codeOf(() => assertRemainingPercent(-1)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertRemainingPercent(101)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertRemainingPercent(50.5)),
      'VALIDATION_FAILED',
    );
  });
});

describe('乱序倒退防护', () => {
  const t1 = new Date('2026-08-29T10:00:00Z');
  const t2 = new Date('2026-08-29T11:00:00Z');

  test('新值覆盖；旧消息不覆盖新值；同消息同时间 replay', () => {
    assert.equal(decideProjectionUpdate(null, { observedAt: t1, sourceMessageId: 'm1' }), 'apply');
    assert.equal(
      decideProjectionUpdate({ observedAt: null, sourceMessageId: null }, { observedAt: t1, sourceMessageId: 'm1' }),
      'apply',
    );
    assert.equal(
      decideProjectionUpdate({ observedAt: t1, sourceMessageId: 'm1' }, { observedAt: t2, sourceMessageId: 'm2' }),
      'apply',
    );
    assert.equal(
      decideProjectionUpdate({ observedAt: t2, sourceMessageId: 'm2' }, { observedAt: t1, sourceMessageId: 'm1' }),
      'stale-rejected',
    );
    assert.equal(
      decideProjectionUpdate({ observedAt: t1, sourceMessageId: 'm1' }, { observedAt: t1, sourceMessageId: 'm1' }),
      'replay',
    );
    assert.equal(
      decideProjectionUpdate({ observedAt: t1, sourceMessageId: 'm1' }, { observedAt: t1, sourceMessageId: 'm9' }),
      'stale-rejected',
      '同时刻不同消息保守拒绝',
    );
  });
});

describe('stale 派生', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  test('未上报 stale；超过阈值 stale；阈值内 fresh', () => {
    assert.ok(isConsumableStale(null, now));
    assert.ok(isConsumableStale(new Date(now.getTime() - CONSUMABLE_STALE_AFTER_MS - 1), now));
    assert.ok(!isConsumableStale(new Date(now.getTime() - 60_000), now));
    assert.ok(!isConsumableStale(new Date(now.getTime() - CONSUMABLE_STALE_AFTER_MS), now), '恰好阈值边界不 stale');
  });
});

describe('更换申请状态机（BE-CNS-02）', () => {
  test('合法迁移：PENDING→PROCESSING/CANCELLED；PROCESSING→COMPLETED/CANCELLED', () => {
    assert.doesNotThrow(() => assertConsumableRequestTransition('PENDING', 'PROCESSING'));
    assert.doesNotThrow(() => assertConsumableRequestTransition('PENDING', 'CANCELLED'));
    assert.doesNotThrow(() => assertConsumableRequestTransition('PROCESSING', 'COMPLETED'));
    assert.doesNotThrow(() => assertConsumableRequestTransition('PROCESSING', 'CANCELLED'));
  });

  test('跳级、重复处理、终态迁移均拒绝（CONFLICT）', () => {
    assert.equal(
      codeOf(() => assertConsumableRequestTransition('PENDING', 'COMPLETED')),
      'CONFLICT',
      '跳级',
    );
    assert.equal(
      codeOf(() => assertConsumableRequestTransition('COMPLETED', 'PROCESSING')),
      'CONFLICT',
      '重复处理',
    );
    assert.equal(
      codeOf(() => assertConsumableRequestTransition('CANCELLED', 'PENDING')),
      'CONFLICT',
      '终态',
    );
    assert.equal(
      codeOf(() => assertConsumableRequestTransition('PENDING', 'PENDING')),
      'CONFLICT',
      '自环',
    );
  });

  test('类型校验：封闭集合外拒绝', () => {
    assert.equal(assertKnownConsumableType('CARBON_FILTER'), 'CARBON_FILTER');
    assert.equal(
      codeOf(() => assertKnownConsumableType('CATALYST')),
      'VALIDATION_FAILED',
    );
  });
});
