import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalWriteInventory } from './qa09-legal-write-inventory.mjs';
test('valid HTTP writes cannot be inflated by malformed, wrong role, wrong method or failed requests', () => {
  const base = {
    method: 'PATCH',
    role: 'PlatformOperator',
    path: '/api/v1/admin/devices/qa09-1234567890abcdef-01/metadata',
    status: 200,
    result: 'PASS',
    id: 'alias',
    requestId: 'own',
  };
  const rows = legalWriteInventory([
    base,
    { ...base, role: 'CustomerViewer' },
    { ...base, status: 400 },
    { ...base, method: 'GET' },
    { ...base, result: 'FAIL' },
  ]);
  assert.equal(rows.length, 63);
  const op = rows.find((r) => r.path.endsWith('/metadata'));
  assert.equal(op.roles.find((r) => r.role === 'PlatformOperator').checks.length, 1);
  assert.equal(op.roles.find((r) => r.role === 'CustomerViewer').result, 'NOT_APPLICABLE');
  assert.equal(op.roles.find((r) => r.role === 'PlatformSuperAdmin').result, 'NOT_RUN');
});
