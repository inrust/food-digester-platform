import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { scanSensitiveSinks } from './check-sensitive-sinks.mjs';

test('生产源码直接 console 与 raw trace API 均被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-sinks-'));
  mkdirSync(join(root, 'apps', 'api', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'apps', 'api', 'src', 'bad.ts'),
    "console.error('secret'); span.setAttribute('token', value);\n",
  );
  assert.deepEqual(
    scanSensitiveSinks(root).map(({ id }) => id),
    ['direct-console', 'raw-trace-attribute'],
  );
});

test('测试目录可使用 console，生产统一 logger 允许', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-sinks-'));
  mkdirSync(join(root, 'packages', 'x', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'x', 'test'), { recursive: true });
  writeFileSync(join(root, 'packages', 'x', 'src', 'ok.ts'), "logger.error('safe', error);\n");
  writeFileSync(join(root, 'packages', 'x', 'test', 'fixture.ts'), "console.error('fixture');\n");
  assert.deepEqual(scanSensitiveSinks(root), []);
});

test('当前仓库生产源码通过 sink 门禁', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(scanSensitiveSinks(root), []);
});
