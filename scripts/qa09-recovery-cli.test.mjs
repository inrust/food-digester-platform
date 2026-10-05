import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
for (const mutation of ['foreign-route', 'failed-cleanup', 'unbound-parent'])
  test('site compensation rejects ' + mutation + ' before any AWS command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa09-recovery-negative-'));
    try {
      const child = {
        prefix: 'qa09-1234567890abcdef',
        customers: [{ id: '11111111-1111-1111-1111-111111111111' }, { id: '22222222-2222-2222-2222-222222222222' }],
        checks: [
          {
            id: 'operator-legal-site-patch',
            result: 'PASS',
            role: 'PlatformOperator',
            status: 200,
            path: '/api/v1/admin/sites/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          },
        ],
      };
      if (mutation === 'foreign-route')
        child.checks[0].path = '/api/v1/admin/customers/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const bytes = JSON.stringify(child);
      const recovered = {
        prefix: child.prefix,
        gate: 'PASS',
        businessReceiptSha256: createHash('sha256').update(bytes).digest('hex'),
        cleanup: [{ type: 'database-fixtures', count: 10, result: 'PASS' }],
      };
      if (mutation === 'failed-cleanup') recovered.cleanup[0].result = 'FAIL';
      if (mutation === 'unbound-parent') recovered.businessReceiptSha256 = '0'.repeat(64);
      writeFileSync(join(dir, 'child.json'), bytes);
      writeFileSync(join(dir, 'recovery.json'), JSON.stringify(recovered));
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/recover-qa09-nonactive-site.mjs'),
          join(dir, 'child.json'),
          join(dir, 'recovery.json'),
          join(dir, 'output.json'),
        ],
        { encoding: 'utf8', env: { ...process.env, PATH: dir }, timeout: 15000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /EXACT_COMPLETED_RECOVERY_AND_SITE_PROOF_REQUIRED/);
      assert.doesNotMatch(result.stderr, /RECOVERY_AWS_READ_FAILED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
