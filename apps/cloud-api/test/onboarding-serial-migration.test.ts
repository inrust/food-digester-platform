import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { expect, test } from 'vitest';
import { readAllMigrationSql } from './helpers.js';

test('历史同序列号多条申请会阻止新迁移，保留历史数据和旧约束', async () => {
  const migration = readFileSync(
    new URL(
      '../../../packages/database/prisma/migrations/20261018090000_onboarding_request_serial_unique/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const sql = readAllMigrationSql();
  expect(sql.endsWith(migration)).toBe(true);
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec(sql.slice(0, -migration.length));
    await db.exec(`INSERT INTO onboarding_requests
      (id, serial_number, submitted_by, model, hardware_version, manufacturer, manufacture_date, csr_pem, public_key_fingerprint, status)
      VALUES ('legacy-1', 'SN-LEGACY', 'DEVICE:SN-LEGACY', 'M', '1', 'B', '2026-01-01', 'CSR1', 'fp1', 'REJECTED'),
             ('legacy-2', 'SN-LEGACY', 'DEVICE:SN-LEGACY', 'M', '1', 'B', '2026-01-01', 'CSR2', 'fp2', 'PENDING')`);
    const before = await db.query('SELECT * FROM onboarding_requests ORDER BY id');
    await expect(db.exec(migration)).rejects.toMatchObject({ code: '23505' });
    await db.exec('ROLLBACK');
    expect(await db.query('SELECT * FROM onboarding_requests ORDER BY id')).toEqual(before);
    const indexes = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'onboarding_requests'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('onboarding_requests_one_pending_per_serial');
    expect(indexes.rows.map((row) => row.indexname)).not.toContain('onboarding_requests_serial_number_key');
  } finally {
    await db.close();
  }
}, 60_000);
