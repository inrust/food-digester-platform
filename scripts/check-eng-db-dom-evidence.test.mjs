import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEngDbDomEvidence,
  DATA_PROCESSING_STRICT_REGRESSIONS,
  DATA_PROCESSING_TASK_DOCUMENTS,
  dataProcessingDocumentErrors,
  IOT_STRICT_REGRESSIONS,
  IOT_TASK_DOCUMENTS,
  iotDocumentErrors,
  iotRegressionEvidenceErrors,
  securityDocumentErrors,
  TASK_DOCUMENTS,
} from './check-eng-db-dom-evidence.mjs';

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

test('BE-IOT-01～08 文档全部纳入默认链接与证据门禁', () => {
  assert.equal(IOT_TASK_DOCUMENTS.length, 8);
  for (const document of IOT_TASK_DOCUMENTS) assert.ok(TASK_DOCUMENTS.includes(document));
  assert.equal(IOT_STRICT_REGRESSIONS.length, 6);
});

test('BE-ARC/RPL/ESG 四份文档及 P2 回归纳入默认证据门禁', () => {
  assert.equal(DATA_PROCESSING_TASK_DOCUMENTS.length, 4);
  for (const document of DATA_PROCESSING_TASK_DOCUMENTS) assert.ok(TASK_DOCUMENTS.includes(document));
  assert.equal(DATA_PROCESSING_STRICT_REGRESSIONS.length, 3);
});

test('BE-ARC/RPL/ESG 文档拒绝缺审计快照和生产接线边界外旧说法', () => {
  const missingAudit = dataProcessingDocumentErrors(
    '执行 pnpm verify。',
    'docs/dev/BE-ARC-01-Transactional-Outbox-Publisher.md',
  );
  assert.ok(missingAudit.some((error) => error.includes('审计快照')));

  const staleBoundary = dataProcessingDocumentErrors(
    '执行 pnpm verify；见 BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md。调度触发归 IAC 边界外。',
    'docs/dev/BE-ESG-01-小时日聚合Worker.md',
  );
  assert.ok(staleBoundary.some((error) => error.includes('生产接线')));
});

test('BE-IOT 文档拒绝缺少审计快照、Report P2002 与 Media 另路由旧说法', () => {
  const missingAudit = iotDocumentErrors('执行 pnpm verify。', 'docs/dev/BE-IOT-01-IoT-Rule消息封装契约.md');
  assert.ok(missingAudit.some((error) => error.includes('审计快照')));

  const staleReport = iotDocumentErrors(
    '执行 pnpm verify；见 BE-IOT-01至BE-IOT-09全面复盘检查报告-2026-09-07.md。重叠由 P2002 收敛。',
    'docs/dev/BE-IOT-06-ESG-Report-Handler.md',
  );
  assert.ok(staleReport.some((error) => error.includes('P2002')));

  const staleMedia = iotDocumentErrors(
    '执行 pnpm verify；见 BE-IOT-01至BE-IOT-09全面复盘检查报告-2026-09-07.md。media 另有路由。',
    'docs/BE-IOT-08-ACK-Handler分发接线.md',
  );
  assert.ok(staleMedia.some((error) => error.includes('Media')));
});

test('BE-IOT 严格负向探针必须保留为可定位的永久回归', () => {
  const root = fixture();
  const missing = iotRegressionEvidenceErrors(root, [
    { finding: 'H-01', file: 'missing.test.ts', anchor: 'strict regression' },
  ]);
  assert.ok(missing.some((error) => error.includes('永久回归测试文件不存在')));

  const stale = iotRegressionEvidenceErrors(root, [
    { finding: 'H-01', file: 'source.ts', anchor: 'strict regression' },
  ]);
  assert.ok(stale.some((error) => error.includes('永久回归测试锚点缺失')));
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
