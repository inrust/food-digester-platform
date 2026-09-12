import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUSINESS_SETTINGS_SCHEMA_VERSION, validateBusinessSettingValue } from './business-settings-v1.js';

const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020.js') as typeof import('ajv').default;

test('四类业务设置共享版本化 JSON Schema 与运行时校验器', async () => {
  const schema = JSON.parse(await readFile(new URL('./business-settings-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.version, BUSINESS_SETTINGS_SCHEMA_VERSION);
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const valid = [
    { key: 'alarm.thresholds', value: { TEMPERATURE_HIGH: { warning: 60, major: 80, critical: 100 } } },
    { key: 'command.confirmation', value: { ttlSec: 300, maxFutureSec: 60 } },
    { key: 'dictionary.displayNames', value: { command: { START: '启动' } } },
    { key: 'notification.business', value: { eventTypes: ['CRITICAL_ALERT_RAISED'], channels: ['EMAIL'] } },
  ] as const;
  for (const item of valid) {
    assert.equal(validate(item), true, JSON.stringify(validate.errors));
    assert.deepEqual(validateBusinessSettingValue(item.key, item.value), []);
  }
  const issues = validateBusinessSettingValue('command.confirmation', { ttlSec: 2, maxFutureSec: 900 });
  assert.deepEqual(
    issues.map((item) => item.path),
    ['/value/ttlSec', '/value/maxFutureSec'],
  );
});
