/**
 * BE-ARC-02 Archive Manifest 契约测试：
 * 合法 fixtures 通过 CT-03 校验器；非法 fixtures 至少一个校验错误。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(dir, 'archive-manifest.schema.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(dir, 'archive-manifest.fixtures.json'), 'utf8'));

const registry = new SchemaRegistry(dir);
const SCHEMA_ID = 'archive-manifest.schema.json';

const baseValid = fixtures.valid[0].manifest;

test('合法 Manifest fixtures 通过校验', () => {
  for (const fixture of fixtures.valid) {
    const errors = validate(schema, SCHEMA_ID, fixture.manifest, registry);
    assert.deepEqual(errors, [], `${fixture.name}: ${JSON.stringify(errors)}`);
  }
});

test('非法 Manifest fixtures 被拒绝', () => {
  for (const fixture of fixtures.invalid) {
    const candidate = structuredClone(baseValid);
    if (fixture.mutate) Object.assign(candidate, fixture.mutate);
    if (fixture.remove) for (const key of fixture.remove) delete candidate[key];
    const errors = validate(schema, SCHEMA_ID, candidate, registry);
    assert.ok(errors.length > 0, `${fixture.name} 必须产生校验错误`);
  }
});
