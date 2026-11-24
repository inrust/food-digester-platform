import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { expect, test } from 'vitest';
import { readAllMigrationSql } from './helpers.js';

const migration = readFileSync(
  new URL('../prisma/migrations/20261124130000_consumable_request_stage_notes/migration.sql', import.meta.url),
  'utf8',
);
const oldTimestamp = '2026-11-01 00:00:00.123456+00';
const laterTimestamp = '2026-11-01 01:00:00+00';

test('R20 backfill uses exact, unique success evidence and preserves legacy data and newer notes', async () => {
  const all = readAllMigrationSql();
  const start = all.indexOf(migration);
  expect(start).toBeGreaterThan(0);
  const pg = new PGlite({ extensions: { btree_gist } });
  try {
    await pg.exec(all.slice(0, start));
    await pg.exec(`
      INSERT INTO customers(id,name,updated_at) VALUES ('tenant','Fixture',now());
      INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,customer_id,lifecycle_status,updated_at)
      VALUES ('device','DEVICE1','M','1','B','2026-01-01','tenant','Active',now());
      INSERT INTO consumable_requests
        (id,customer_id,device_id,consumable_type,status,requested_by,requested_at,created_at,updated_at,processed_by,process_note,version)
      VALUES
        ('completed','tenant','device','CARBON_FILTER','COMPLETED','requester','${oldTimestamp}','${oldTimestamp}',now(),'closer','legacy completion',3),
        ('cancelled','tenant','device','BIO_ADDITIVE','CANCELLED','requester','${oldTimestamp}','${oldTimestamp}',now(),'closer','legacy cancellation',2),
        ('ambiguous-a','tenant','device','CARBON_FILTER','CANCELLED','requester','${laterTimestamp}','${laterTimestamp}',now(),'closer','unknown A',3),
        ('ambiguous-b','tenant','device','CARBON_FILTER','CANCELLED','requester','${laterTimestamp}','${laterTimestamp}',now(),'closer','unknown B',2),
        ('optional','tenant','device','BIO_ADDITIVE','PROCESSING','requester','${laterTimestamp}','${laterTimestamp}',now(),'processor',NULL,2);
    `);
    async function writeAudit({
      id,
      objectId,
      stage,
      actor,
      reason,
      before,
      after,
      result = 'SUCCESS',
      time = laterTimestamp,
    }: {
      id: string;
      objectId: string;
      stage: string;
      actor: string;
      reason: string | null;
      before?: { version: number };
      after: Record<string, unknown>;
      result?: 'SUCCESS' | 'FAILURE';
      time?: string;
    }) {
      await pg.query(
        `INSERT INTO audit_logs (id, object_type, object_id, action, actor_id, customer_id, reason, before_value, after_value, result, created_at)
         VALUES ($1, 'consumableRequest', $2, $3, $4, 'tenant', $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz)`,
        [
          id,
          objectId,
          `consumable.request.${stage}`,
          actor,
          reason,
          before ? JSON.stringify(before) : null,
          JSON.stringify(after),
          result,
          time,
        ],
      );
    }
    await writeAudit({
      id: 'a-create',
      objectId: 'device',
      stage: 'create',
      actor: 'requester',
      time: oldTimestamp,
      reason: 'legacy request',
      after: { deviceId: 'device', consumableType: 'CARBON_FILTER', status: 'PENDING' },
    });
    await writeAudit({
      id: 'a-ambiguous-create',
      objectId: 'device',
      stage: 'create',
      actor: 'requester',
      reason: 'cannot link to one request',
      after: { deviceId: 'device', consumableType: 'CARBON_FILTER', status: 'PENDING' },
    });
    const processing = { version: 2, status: 'PROCESSING', processedBy: 'processor' };
    await writeAudit({
      id: 'a-process',
      objectId: 'completed',
      stage: 'process',
      actor: 'processor',
      reason: 'legacy processing',
      before: { version: 1 },
      after: processing,
    });
    await writeAudit({
      id: 'a-process-failed',
      objectId: 'completed',
      stage: 'process',
      actor: 'processor',
      reason: 'failed alternative',
      before: { version: 1 },
      after: processing,
      result: 'FAILURE',
    });
    const completion = { version: 3, status: 'COMPLETED', processedBy: 'closer' };
    await writeAudit({
      id: 'a-complete',
      objectId: 'completed',
      stage: 'complete',
      actor: 'closer',
      reason: 'legacy completion',
      before: { version: 2 },
      after: completion,
    });
    await writeAudit({
      id: 'a-cancel',
      objectId: 'cancelled',
      stage: 'cancel',
      actor: 'closer',
      reason: 'legacy cancellation',
      before: { version: 1 },
      after: { version: 2, status: 'CANCELLED', processedBy: 'closer' },
    });
    for (const suffix of ['one', 'two']) {
      await writeAudit({
        id: `a-duplicate-${suffix}`,
        objectId: 'ambiguous-a',
        stage: 'process',
        actor: 'processor',
        reason: suffix,
        before: { version: 1 },
        after: processing,
      });
    }
    await writeAudit({
      id: 'a-optional',
      objectId: 'optional',
      stage: 'process',
      actor: 'processor',
      reason: null,
      before: { version: 1 },
      after: processing,
    });

    const originalSql = "SELECT to_jsonb(r) - 'stage_notes' AS row FROM consumable_requests AS r ORDER BY id";
    const original = (await pg.query(originalSql)).rows;
    await pg.exec(migration);
    expect((await pg.query(originalSql)).rows).toEqual(original);
    const selectNotes = 'SELECT id, stage_notes FROM consumable_requests ORDER BY id';
    const snapshot = (await pg.query(selectNotes)).rows;
    expect(snapshot).toEqual([
      { id: 'ambiguous-a', stage_notes: { legacy: ['unknown A'] } },
      { id: 'ambiguous-b', stage_notes: { legacy: ['unknown B'] } },
      {
        id: 'cancelled',
        stage_notes: { cancellation: { note: 'legacy cancellation', source: 'AUDIT', auditId: 'a-cancel' } },
      },
      {
        id: 'completed',
        stage_notes: {
          request: { note: 'legacy request', source: 'AUDIT', auditId: 'a-create' },
          processing: { note: 'legacy processing', source: 'AUDIT', auditId: 'a-process' },
          completion: { note: 'legacy completion', source: 'AUDIT', auditId: 'a-complete' },
        },
      },
      { id: 'optional', stage_notes: null },
    ]);
    await pg.exec(migration);
    expect((await pg.query(selectNotes)).rows).toEqual(snapshot);
    await pg.exec(`UPDATE consumable_requests SET stage_notes = jsonb_set(stage_notes, '{processing}',
      '{"note":"new server note","source":"RECORDED"}') WHERE id = 'completed'`);
    await pg.exec(migration);
    const retained = await pg.query(
      "SELECT stage_notes->'processing' AS note FROM consumable_requests WHERE id = 'completed'",
    );
    expect(retained.rows).toEqual([{ note: { note: 'new server note', source: 'RECORDED' } }]);
  } finally {
    await pg.close();
  }
}, 60_000);
