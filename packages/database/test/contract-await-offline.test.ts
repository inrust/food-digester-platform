import { test, assert, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFileSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { withDataPathTrace } from '@fdp/observability';
import { createAdminPreconnectCandidate } from '../src/client.js';
import { observeContractLoad } from '../src/contract-load-observation.js';
import { readAuthenticatedAccount } from '../../../apps/cloud-api/src/admin/user/account-read-candidate.js';
import { readContractForUpdate } from '../../../apps/cloud-api/src/admin/contract/load-candidate.js';
import { validateContractAwaitCheckpoint } from '../../../scripts/qa09-contract-load-detail-proof.mjs';

const cases = [
  'orm-zero',
  'native-zero',
  'orm-wait',
  'native-wait',
  'orm-result',
  'native-result',
  'orm-reject',
  'native-reject',
  'native-invalid',
  'native-update-reject',
  'native-audit-reject',
];
const selected = process.env.QA09_AWAIT_CASE;
if (selected && !cases.includes(selected)) throw Error('INVALID_AWAIT_CASE');
const id = 'offline-text-contract'; // schema uses text, deliberately not UUID
const columns = [
  'id',
  'contract_number',
  'name',
  'customer_id',
  'contact',
  'start_at',
  'end_at',
  'status',
  'version',
  'created_by',
  'created_at',
  'updated_at',
];
const aliases = [
  'id',
  'contractNumber',
  'name',
  'customerId',
  'contact',
  'startAt',
  'endAt',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
];
const values = [
  id,
  'offline-number',
  'offline',
  'offline-customer',
  null,
  '2026-01-01T00:00:00.000Z',
  '2027-01-01T00:00:00.000Z',
  'DRAFT',
  1,
  'offline-actor',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
];
for (const name of cases)
  (selected && selected !== name ? test.skip : test)(`bounded contract await chain ${name}`, async () => {
    const native = name.startsWith('native-'),
      failureExpected = name.includes('reject') || name.endsWith('invalid');
    const delayMs = name.endsWith('-wait') ? 30 : 0,
      resultCpuMs = name.endsWith('-result') ? 20 : 0;
    let stage = 'idle';
    const counts = {
      checkout: 0,
      release: 0,
      begin: 0,
      commit: 0,
      rollback: 0,
      account: 0,
      load: 0,
      update: 0,
      readback: 0,
      audit: 0,
      dispose: 0,
    };
    const error = Object.assign(Error('CONTROLLED_FAILURE'), { code: '40001' });
    const release = () => counts.release++;
    const driver = Object.assign(new EventEmitter(), {
      release,
      async query(config: { text: string; values?: unknown[] }) {
        const sql = config.text.trimStart();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
          counts[sql.toLowerCase() as 'begin' | 'commit' | 'rollback']++;
          return { rows: [], fields: [], rowCount: 0 };
        }
        if (stage === 'account') {
          counts.account++;
          return { rows: [], fields: [], rowCount: 0 };
        }
        assert.include(['load', 'update', 'readback', 'audit'], stage);
        counts[stage as 'load' | 'update' | 'readback' | 'audit']++;
        if (
          (stage === 'load' && name.endsWith('-reject') && !name.includes('update-') && !name.includes('audit-')) ||
          (stage === 'update' && name === 'native-update-reject') ||
          (stage === 'audit' && name === 'native-audit-reject')
        )
          throw error;
        if (stage === 'update') return { rows: [], fields: [], rowCount: 1 };
        if (stage === 'audit')
          return { rows: [['offline-audit']], fields: [{ name: 'id', dataTypeID: 25 }], rowCount: 1 };
        if (stage === 'load' && delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (native && stage === 'load') {
          assert.include(sql, 'WHERE id = $1');
          assert.deepEqual(config.values, [id]);
        }
        const row = [...values];
        if (stage === 'readback') {
          row[8] = 2;
          row[2] = 'updated';
        }
        if (name === 'native-invalid') row[8] = 0;
        const fields = native && stage === 'load' ? aliases : columns;
        return {
          rows: [row],
          rowCount: 1,
          get fields() {
            const until = performance.now() + (stage === 'load' ? resultCpuMs : 0);
            while (performance.now() < until) {
              /* controlled result access, not real decoder attribution */
            }
            return fields.map((field, i) => ({
              name: field,
              dataTypeID: i === 8 ? 23 : [5, 6, 10, 11].includes(i) ? 1184 : 25,
            }));
          },
        };
      },
    });
    const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback?: any) => {
      counts.checkout++;
      if (callback) {
        callback(undefined, driver, release);
        return undefined as never;
      }
      return Promise.resolve(driver) as never;
    });
    const root = vi.spyOn(Pool.prototype, 'query').mockImplementation(async () => {
      assert.equal(stage, 'account');
      counts.account++;
      return { rows: [], fields: [], rowCount: 0 } as never;
    });
    const end = vi.spyOn(Pool.prototype, 'end').mockImplementation(async () => {
      counts.dispose++;
    });
    const old = process.env.FDP_DB_POOL_MAX;
    process.env.FDP_DB_POOL_MAX = '1';
    const owner = createAdminPreconnectCandidate('postgresql://offline:offline@invalid.invalid:1/offline', true);
    const samples: Record<string, unknown>[] = [];
    try {
      await owner.prepareAuthenticated();
      stage = 'account';
      assert.isNull(await readAuthenticatedAccount(owner.client as never, 'offline-sub', true));
      for (let index = 0; index < (failureExpected ? 1 : 3); index++) {
        const rows: Record<string, unknown>[] = [],
          windowsMs: Record<string, number> = {};
        let failed = false;
        try {
          await withDataPathTrace(
            {
              lambdaRequestId: `await-${name}-${index}`,
              gatewayRequestId: `await-${name}-${index}`,
              operationId: 'updateContract',
            },
            () =>
              owner.client.$transaction(async (tx) => {
                const measure = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
                  stage = key;
                  const started = performance.now();
                  try {
                    return await work();
                  } finally {
                    windowsMs[key] = Math.round((performance.now() - started) * 1000) / 1000;
                  }
                };
                const row = await measure('load', () =>
                  observeContractLoad(() => readContractForUpdate(tx as never, id, native)),
                );
                assert.equal(row?.version, 1);
                assert.instanceOf(row?.startAt, Date);
                assert.isNull(row?.contact);
                const updated = await measure('update', () =>
                  tx.contract.updateMany({
                    where: { id, version: 1 },
                    data: { name: 'updated', version: { increment: 1 } },
                  }),
                );
                assert.equal(updated.count, 1);
                const fresh = await measure('readback', () => tx.contract.findFirst({ where: { id } }));
                assert.equal(fresh?.version, 2);
                assert.equal(fresh?.name, 'updated');
                // Same audit model/transaction; reduced return projection is explicitly offline-only.
                await measure('audit', () =>
                  tx.auditLog.create({
                    data: { objectType: 'contract', objectId: id, action: 'contract.update', result: 'SUCCESS' },
                    select: { id: true },
                  }),
                );
              }),
            (r) => rows.push(r),
          );
        } catch {
          failed = true;
        }
        assert.equal(failed, failureExpected);
        const phases = rows.filter((r) => r.event === 'data-path.phase.completed'),
          ownership = rows.filter((r) => r.event === 'data-path.contract-load.ownership');
        if (!native && !failed) assert.equal(validateContractAwaitCheckpoint(phases, ownership, true)?.gate, 'PASS');
        if (native) {
          assert.equal(ownership.length, 1);
          assert.equal(ownership[0].modelEntries, 0); // Native query must never impersonate a Contract model observation.
          assert.equal(ownership[0].driverDispatches, 1);
          assert.equal(ownership[0].transactional, true);
          assert.isFalse(phases.some((r) => r.phase === 'contract-load-orm-prepare'));
          assert.throws(() => validateContractAwaitCheckpoint(phases, ownership, true));
        }
        samples.push({ index, firstForClient: index === 0, failed, windowsMs, observations: rows });
      }
      const n = samples.length;
      assert.equal(counts.account, 1);
      assert.equal(counts.checkout, n + 1);
      assert.equal(counts.release, counts.checkout);
      assert.equal(counts.begin, n);
      assert.equal(counts.commit, failureExpected ? 0 : n);
      assert.equal(counts.rollback, failureExpected ? 1 : 0);
      assert.equal(counts.load, n);
      assert.equal(
        counts.update,
        failureExpected && !['native-update-reject', 'native-audit-reject'].includes(name) ? 0 : n,
      );
      assert.equal(counts.readback, failureExpected && name !== 'native-audit-reject' ? 0 : n);
      assert.equal(counts.audit, failureExpected && name !== 'native-audit-reject' ? 0 : n);
      await owner.client.$disconnect();
      assert.equal(counts.dispose, 1);
      const receipt = {
        gate: 'PASS',
        source: 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
        case: name,
        native,
        accountNative: true,
        poolMax: 1,
        delayMs,
        resultCpuMs,
        counts,
        samples,
        auditReturnProjection: 'ID_ONLY_OFFLINE',
        targetEquivalent: false,
        compilerOnlyAttribution: false,
        modelCostShift: 'OBSERVATIONS_ONLY',
        p95Accepted: false,
        fullQa09Accepted: false,
      };
      assert.notInclude(JSON.stringify(receipt), 'postgresql');
      assert.notInclude(JSON.stringify(receipt), 'SELECT');
      if (selected && process.env.QA09_AWAIT_OUTPUT) {
        assert.isFalse(existsSync(process.env.QA09_AWAIT_OUTPUT));
        writeFileSync(process.env.QA09_AWAIT_OUTPUT, JSON.stringify(receipt, null, 2) + '\n');
      }
    } finally {
      await owner.client.$disconnect();
      if (old === undefined) delete process.env.FDP_DB_POOL_MAX;
      else process.env.FDP_DB_POOL_MAX = old;
      connect.mockRestore();
      root.mockRestore();
      end.mockRestore();
    }
  });
