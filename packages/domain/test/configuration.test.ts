/**
 * BE-CFG-01 Configuration 领域规则单测：DEC-018 封闭字段、冻结范围与版本生命周期。
 */
import { assert, describe, test } from 'vitest';
import {
  CONFIGURATION_LIMITS,
  ConfigurationError,
  assertPublishableVersion,
  selectEffectiveVersion,
  validateConfigurationPayload,
} from '../src/index.js';
import type { ConfigurationPayload } from '../src/index.js';

function validPayload(): ConfigurationPayload {
  return {
    heartbeatInterval: 60,
    telemetryInterval: 30,
    cameraRefreshInterval: 1,
    temperatureThreshold: 80,
  };
}

function fieldErrors(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigurationError);
    assert.equal(err.code, 'VALIDATION_FAILED');
    return err.fieldErrors;
  }
  assert.fail('should throw ConfigurationError');
}

describe('validateConfigurationPayload', () => {
  test('合法载荷原样通过', () => {
    const payload = validPayload();
    assert.deepEqual(validateConfigurationPayload(payload), payload);
  });

  test('非法频率/阈值逐项拒绝', () => {
    const cases: [string, (p: Record<string, unknown>) => void][] = [
      ['heartbeatInterval', (p) => Object.assign(p, { heartbeatInterval: 9 })],
      ['telemetryInterval', (p) => Object.assign(p, { telemetryInterval: 4 })],
      ['cameraRefreshInterval', (p) => Object.assign(p, { cameraRefreshInterval: 1441 })],
      ['temperatureThreshold', (p) => Object.assign(p, { temperatureThreshold: 121 })],
    ];
    for (const [field, mutate] of cases) {
      const payload: Record<string, unknown> = { ...validPayload() };
      mutate(payload);
      const errors = fieldErrors(() => validateConfigurationPayload(payload));
      assert.ok(
        errors.some((e) => e.startsWith(`${field}:`)),
        `${field} 应有字段错误: ${errors.join('; ')}`,
      );
    }
  });

  test('派生字段（contract/region/subregion/site/alias）提交即拒绝', () => {
    for (const key of ['contract', 'region', 'subregion', 'site', 'alias']) {
      const errors = fieldErrors(() => validateConfigurationPayload({ ...validPayload(), [key]: 'x' }));
      assert.ok(
        errors.some((e) => e.startsWith(`${key}: is derived`)),
        `${key}: ${errors.join('; ')}`,
      );
    }
  });

  test('DEC-018 排除的网络字段（cloudDomain/ntpServer）提交即拒绝', () => {
    for (const key of ['cloudDomain', 'ntpServer']) {
      const errors = fieldErrors(() => validateConfigurationPayload({ ...validPayload(), [key]: 'x' }));
      assert.ok(
        errors.some((e) => e.startsWith(`${key}: is excluded`)),
        `${key}: ${errors.join('; ')}`,
      );
    }
  });

  test('封闭 Schema：未知字段/缺字段/非对象均拒绝', () => {
    assert.ok(
      fieldErrors(() => validateConfigurationPayload({ ...validPayload(), extra: 1 })).some(
        (e) => e === 'extra: unknown field',
      ),
    );
    const missing = { ...validPayload() } as Record<string, unknown>;
    delete missing.cameraRefreshInterval;
    assert.ok(
      fieldErrors(() => validateConfigurationPayload(missing)).some((e) => e === 'cameraRefreshInterval: is required'),
    );
    assert.ok(fieldErrors(() => validateConfigurationPayload(null)).some((e) => e === 'payload: must be an object'));
  });

  test('DEC-018 冻结范围、默认值与单位稳定', () => {
    assert.deepEqual(CONFIGURATION_LIMITS.heartbeatInterval, { min: 10, max: 900, default: 60, unit: 'seconds' });
    assert.deepEqual(CONFIGURATION_LIMITS.telemetryInterval, { min: 5, max: 3600, default: 30, unit: 'seconds' });
    assert.deepEqual(CONFIGURATION_LIMITS.cameraRefreshInterval, {
      min: 1,
      max: 1440,
      default: 1,
      unit: 'minutes',
    });
    assert.deepEqual(CONFIGURATION_LIMITS.temperatureThreshold, { min: 0, max: 120, default: 80, unit: 'celsius' });
  });
});

describe('版本生命周期', () => {
  test('仅 DRAFT 可发布；PUBLISHED 不可覆盖', () => {
    assert.doesNotThrow(() => assertPublishableVersion('DRAFT'));
    try {
      assertPublishableVersion('PUBLISHED');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof ConfigurationError);
      assert.equal(err.code, 'CONFLICT');
    }
  });

  test('selectEffectiveVersion：已发布且已到 effectiveAt 的最高版本', () => {
    const at = new Date('2026-08-29T12:00:00Z');
    const versions = [
      { version: 1, status: 'PUBLISHED', effectiveAt: new Date('2026-08-01T00:00:00Z') },
      { version: 2, status: 'PUBLISHED', effectiveAt: new Date('2026-08-29T00:00:00Z') },
      { version: 3, status: 'PUBLISHED', effectiveAt: new Date('2026-09-01T00:00:00Z') }, // 未来生效
      { version: 4, status: 'DRAFT', effectiveAt: null },
    ];
    assert.equal(selectEffectiveVersion(versions, at)?.version, 2);
    assert.equal(selectEffectiveVersion([], at), null);
    assert.equal(
      selectEffectiveVersion([{ version: 1, status: 'PUBLISHED', effectiveAt: new Date('2026-09-01T00:00:00Z') }], at),
      null,
    );
  });
});
