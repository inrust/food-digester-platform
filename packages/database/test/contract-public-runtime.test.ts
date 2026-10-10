import { test, assert, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFileSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { Socket } from 'node:net';
import { validateContractPublicBoundaries } from '../../../scripts/qa09-contract-public-proof.mjs';
import { withDataPathTrace } from '@fdp/observability';
import { createAdminPreconnectCandidate } from '../src/client.js';
import { observeContractLoad } from '../src/contract-load-observation.js';
import { readAuthenticatedAccount } from '../../../apps/cloud-api/src/admin/user/account-read-candidate.js';
import { readContractForUpdate } from '../../../apps/cloud-api/src/admin/contract/load-candidate.js';
import { validateContractAwaitCheckpoint } from '../../../scripts/qa09-contract-load-detail-proof.mjs';

const cases = ['off', 'on', 'pg-wait', 'fields-cpu', 'pg-reject', 'validation-reject', 'update-reject', 'audit-reject'];
const selected = process.env.QA09_PUBLIC_CASE;
if (selected && !cases.includes(selected)) throw Error('INVALID_PUBLIC_CASE');
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
  (selected && selected !== name ? test.skip : test)(
    `real runtime public seam without forced yields ${name}`,
    async () => {
      const native = false,
        enabled = name !== 'off',
        failureExpected = name.endsWith('reject');
      const delayMs = name === 'pg-wait' ? 30 : 0,
        resultCpuMs = name === 'fields-cpu' ? 20 : 0;
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
        network: 0,
        pools: 0,
      };
      const network = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        counts.network++;
        throw Error('NETWORK_FORBIDDEN');
      });
      const pools = new Set<Pool>();
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
            (stage === 'load' && name === 'pg-reject') ||
            (stage === 'update' && name === 'update-reject') ||
            (stage === 'audit' && name === 'audit-reject')
          )
            throw error;
          if (stage === 'update') return { rows: [], fields: [], rowCount: 1 };
          if (stage === 'audit')
            return { rows: [['offline-audit']], fields: [{ name: 'id', dataTypeID: 25 }], rowCount: 1 };
          if (stage === 'load' && delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const row = [...values];
          if (stage === 'readback') {
            row[8] = 2;
            row[2] = 'updated';
          }

          const fields = columns;
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
      const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (this: Pool, callback?: any) {
        pools.add(this);
        assert.equal(this.options.max, 1);
        counts.checkout++;
        if (callback) {
          callback(undefined, driver, release);
          return undefined as never;
        }
        return Promise.resolve(driver) as never;
      });
      const root = vi.spyOn(Pool.prototype, 'query').mockImplementation(async function (this: Pool) {
        pools.add(this);
        assert.equal(this.options.max, 1);
        assert.equal(stage, 'account');
        counts.account++;
        return { rows: [], fields: [], rowCount: 0 } as never;
      });
      const end = vi.spyOn(Pool.prototype, 'end').mockImplementation(async () => {
        counts.dispose++;
      });
      const old = process.env.FDP_DB_POOL_MAX;
      process.env.FDP_DB_POOL_MAX = '1';
      const owner = createAdminPreconnectCandidate(
        'postgresql://offline:offline@invalid.invalid:1/offline',
        true,
        enabled,
      );
      const samples: Record<string, unknown>[] = [];
      try {
        await owner.prepareAuthenticated();
        stage = 'account';
        assert.isNull(await readAuthenticatedAccount(owner.client as never, 'offline-sub', true));
        for (let index = 0; index < (failureExpected ? 1 : 3); index++) {
          const rows: Record<string, unknown>[] = [],
            windowsMs: Record<string, number> = {};
          let failed = false,
            expectedFailureMatched = false;
          try {
            await withDataPathTrace(
              {
                lambdaRequestId: `public-${name}-${index}`,
                gatewayRequestId: `public-${name}-${index}`,
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
                    observeContractLoad(() =>
                      name === 'validation-reject'
                        ? tx.contract.findFirst({ where: { invalidOfflineField: true } as never })
                        : readContractForUpdate(tx as never, id, native),
                    ),
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
          } catch (caught) {
            failed = true;
            expectedFailureMatched =
              name === 'validation-reject'
                ? (caught as Error).name === 'PrismaClientValidationError'
                : (caught as { code?: string })?.code === error.code;
          }
          assert.equal(failed, failureExpected);
          const phases = rows.filter((r) => r.event === 'data-path.phase.completed'),
            ownership = rows.filter((r) => r.event === 'data-path.contract-load.ownership');
          if (!['pg-reject', 'validation-reject'].includes(name)) {
            assert.equal(validateContractAwaitCheckpoint(phases, ownership, true)?.gate, 'PASS');
            if (enabled) {
              const proof = validateContractPublicBoundaries(phases, ownership, true)!;
              assert.equal(proof.gate, 'PASS');
              if (name === 'pg-wait') assert.isAtLeast(proof.windowsMs['contract-load-pg-await']!, 27);
              if (name === 'fields-cpu')
                assert.isAtLeast(
                  phases.find((p) => p.phase === 'contract-load-driver-after-pg')!.durationMs as number,
                  17,
                );
            } else {
              assert.isNull(validateContractPublicBoundaries(phases, ownership));
              assert.throws(() => validateContractPublicBoundaries(phases, ownership, true));
            }
          } else assert.throws(() => validateContractPublicBoundaries(phases, ownership, true));
          if (failureExpected) assert.isTrue(expectedFailureMatched);
          samples.push({
            index,
            firstForClient: index === 0,
            failed,
            expectedFailureMatched,
            windowsMs,
            observations: rows,
          });
        }
        const n = samples.length;
        assert.equal(counts.account, 1);
        assert.equal(counts.checkout, n + 1);
        assert.equal(counts.release, counts.checkout);
        assert.equal(counts.begin, n);
        assert.equal(counts.commit, failureExpected ? 0 : n);
        assert.equal(counts.rollback, failureExpected ? 1 : 0);
        assert.equal(counts.load, name === 'validation-reject' ? 0 : n);
        assert.equal(counts.update, failureExpected && !['update-reject', 'audit-reject'].includes(name) ? 0 : n);
        assert.equal(counts.readback, failureExpected && name !== 'audit-reject' ? 0 : n);
        assert.equal(counts.audit, failureExpected && name !== 'audit-reject' ? 0 : n);
        await owner.client.$disconnect();
        assert.equal(counts.dispose, 1);
        counts.pools = pools.size;
        assert.equal(counts.pools, 1);
        assert.equal(counts.network, 0);
        const receipt = {
          kind: 'qa09-runtime-public-seams/v1',
          enabled,
          forcedYields: 0,
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
        if (selected && process.env.QA09_PUBLIC_OUTPUT) {
          assert.isFalse(existsSync(process.env.QA09_PUBLIC_OUTPUT));
          writeFileSync(process.env.QA09_PUBLIC_OUTPUT, JSON.stringify(receipt, null, 2) + '\n');
        }
      } finally {
        await owner.client.$disconnect();
        if (old === undefined) delete process.env.FDP_DB_POOL_MAX;
        else process.env.FDP_DB_POOL_MAX = old;
        network.mockRestore();
        connect.mockRestore();
        root.mockRestore();
        end.mockRestore();
      }
    },
  );
