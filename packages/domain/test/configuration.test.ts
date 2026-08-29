/**
 * BE-CFG-01 Configuration 领域规则单测：封闭字段、范围与交叉校验、版本生命周期。
 */
import { assert, describe, test } from 'vitest';
import {
  CONFIGURATION_LANGUAGES,
  CONFIGURATION_LIMITS,
  ConfigurationError,
  assertPublishableVersion,
  selectEffectiveVersion,
  validateConfigurationPayload,
} from '../src/index.js';
import type { ConfigurationPayload } from '../src/index.js';

function validPayload(): ConfigurationPayload {
  return {
    image: { width: 640, height: 480, uploadIntervalSeconds: 300 },
    rotation: { intervalMinutes: 30, durationSeconds: 120 },
    motor: { overloadCurrentAmps: 5 },
    heating: { minTemperatureCelsius: 35, maxTemperatureCelsius: 55 },
    language: 'zh-CN',
    heartbeatInterval: 60,
    telemetryInterval: 300,
    cameraRefreshInterval: 30,
    temperatureThreshold: 70,
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

  test('非法频率/尺寸/阈值逐项拒绝', () => {
    const cases: [string, (p: Record<string, unknown>) => void][] = [
      ['heartbeatInterval', (p) => Object.assign(p, { heartbeatInterval: 10 })],
      ['telemetryInterval', (p) => Object.assign(p, { telemetryInterval: 30 })],
      ['cameraRefreshInterval', (p) => Object.assign(p, { cameraRefreshInterval: 1000 })],
      ['temperatureThreshold', (p) => Object.assign(p, { temperatureThreshold: 200 })],
      ['image.width', (p) => Object.assign(p, { image: { width: 100, height: 480, uploadIntervalSeconds: 300 } })],
      ['image.height', (p) => Object.assign(p, { image: { width: 640, height: 2000, uploadIntervalSeconds: 300 } })],
      [
        'image.uploadIntervalSeconds',
        (p) => Object.assign(p, { image: { width: 640, height: 480, uploadIntervalSeconds: 10 } }),
      ],
      ['motor.overloadCurrentAmps', (p) => Object.assign(p, { motor: { overloadCurrentAmps: 100 } })],
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

  test('交叉校验：minTemperature ≥ maxTemperature 拒绝；旋转时长 N ≥ 间隔 M 拒绝', () => {
    const heating = fieldErrors(() =>
      validateConfigurationPayload({
        ...validPayload(),
        heating: { minTemperatureCelsius: 55, maxTemperatureCelsius: 55 },
      }),
    );
    assert.ok(heating.some((e) => e.startsWith('heating.minTemperatureCelsius:')));
    const rotation = fieldErrors(() =>
      validateConfigurationPayload({ ...validPayload(), rotation: { intervalMinutes: 1, durationSeconds: 60 } }),
    );
    assert.ok(rotation.some((e) => e.startsWith('rotation.durationSeconds:')));
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

  test('未冻结网络字段（cloudDomain/ntpServer）提交即拒绝', () => {
    for (const key of ['cloudDomain', 'ntpServer']) {
      const errors = fieldErrors(() => validateConfigurationPayload({ ...validPayload(), [key]: 'x' }));
      assert.ok(
        errors.some((e) => e.startsWith(`${key}: is not frozen`)),
        `${key}: ${errors.join('; ')}`,
      );
    }
  });

  test('封闭 Schema：未知字段/缺字段/非法语言/非对象均拒绝', () => {
    assert.ok(
      fieldErrors(() => validateConfigurationPayload({ ...validPayload(), extra: 1 })).some(
        (e) => e === 'extra: unknown field',
      ),
    );
    const missing = { ...validPayload() } as Record<string, unknown>;
    delete missing.language;
    assert.ok(fieldErrors(() => validateConfigurationPayload(missing)).some((e) => e === 'language: is required'));
    assert.ok(
      fieldErrors(() => validateConfigurationPayload({ ...validPayload(), language: 'fr-FR' })).some((e) =>
        e.startsWith('language: must be one of'),
      ),
    );
    assert.ok(fieldErrors(() => validateConfigurationPayload(null)).some((e) => e === 'payload: must be an object'));
    assert.ok(
      fieldErrors(() =>
        validateConfigurationPayload({
          ...validPayload(),
          image: { width: 640, height: 480, uploadIntervalSeconds: 300, zoom: 2 },
        }),
      ).some((e) => e === 'image.zoom: unknown field'),
    );
  });

  test('语言与范围常量稳定（暂定值可整体替换）', () => {
    assert.deepEqual(CONFIGURATION_LANGUAGES, ['zh-CN', 'en-US']);
    assert.equal(CONFIGURATION_LIMITS.heartbeatInterval.min, 30);
    assert.ok(
      CONFIGURATION_LIMITS.heating.minTemperatureCelsius.max <= CONFIGURATION_LIMITS.heating.maxTemperatureCelsius.max,
    );
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
