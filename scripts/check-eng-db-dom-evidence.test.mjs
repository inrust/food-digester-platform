import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEngDbDomEvidence, securityDocumentErrors } from './check-eng-db-dom-evidence.mjs';

function fixture({ document = '[source](../../source.ts)', manifest = {}, nvmrc = '24.12.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fdp-evidence-'));
  mkdirSync(join(root, 'docs/dev'), { recursive: true });
  writeFileSync(join(root, 'docs/dev/task.md'), document);
  writeFileSync(join(root, 'source.ts'), 'export {};');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ engines: { node: '>=24.12 <25' }, packageManager: 'pnpm@10.20.0', ...manifest }),
  );
  writeFileSync(join(root, '.nvmrc'), nvmrc);
  return root;
}

test('有效链接、无易漂移计数且工具链配对正确时通过', () => {
  assert.deepEqual(checkEngDbDomEvidence(fixture(), ['docs/dev/task.md']), []);
});

test('损坏的仓库内 Markdown 链接被拒绝', () => {
  const errors = checkEngDbDomEvidence(fixture({ document: '[missing](../../missing.ts)' }), ['docs/dev/task.md']);
  assert.ok(errors.some((error) => error.includes('链接目标不存在')));
});

test('陈旧测试计数或不兼容工具链声明被拒绝', () => {
  const root = fixture({
    document: 'Vitest 683/683，合计 1003/1003。',
    manifest: { engines: { node: '>=20' }, packageManager: 'pnpm@11.21.0' },
    nvmrc: '20',
  });
  const errors = checkEngDbDomEvidence(root, ['docs/dev/task.md']);
  assert.ok(errors.some((error) => error.includes('测试数量')));
  assert.ok(errors.some((error) => error.includes('engines.node')));
  assert.ok(errors.some((error) => error.includes('packageManager')));
  assert.ok(errors.some((error) => error.includes('.nvmrc')));
});

test('当前仓库 ENG/DB/DOM 与 IAC/AUTH/SEC 任务文档证据一致', () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.deepEqual(checkEngDbDomEvidence(root), []);
});

test('安全任务文档拒绝历史计数、缺少 verify 命令与陈旧 DEC-012 状态', () => {
  const errors = securityDocumentErrors(
    '测试 4 个文件、29 项。DEC-012 仍为 `pending`。',
    'docs/dev/AUTH-01-Cognito认证与角色授权.md',
    { decisions: [{ id: 'DEC-012', status: 'frozen', version: '1.0.0' }] },
  );
  assert.ok(errors.some((error) => error.includes('pnpm verify')));
  assert.ok(errors.some((error) => error.includes('测试文件或用例计数')));
  assert.ok(errors.some((error) => error.includes('文档状态')));
});

test('安全任务文档接受当前命令、审计快照引用与 frozen 决策', () => {
  const errors = securityDocumentErrors(
    '当前执行 `pnpm verify`；精确结果见 docs/audit。DEC-012 已冻结为 `1.0.0`。',
    'docs/dev/AUTH-01-Cognito认证与角色授权.md',
    { decisions: [{ id: 'DEC-012', status: 'frozen', version: '1.0.0' }] },
  );
  assert.deepEqual(errors, []);
});
