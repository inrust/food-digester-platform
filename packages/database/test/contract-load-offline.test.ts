import { test, assert, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFileSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { withDataPathTrace } from '@fdp/observability';
import { createAdminPreconnectCandidate } from '../src/client.js';
import { ObservedPrismaPg } from '../src/observed-pg.js';
import { observeContractLoad } from '../src/contract-load-observation.js';
import { readAuthenticatedAccount } from '../../../apps/cloud-api/src/admin/user/account-read-candidate.js';
import { validateContractLoadDetail } from '../../../scripts/qa09-contract-load-detail-proof.mjs';
import { validateContractLoadSplit } from '../../../scripts/qa09-contract-load-proof.mjs';

export const cases = [
  'orm-zero',
  'raw-zero',
  'orm-wait',
  'raw-wait',
  'orm-result',
  'raw-result',
  'raw-reject',
  'raw-invalid',
];
const id = '00000000-0000-4000-8000-000000000001';
const names = [
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
  'offline-contract',
  'offline',
  id,
  null,
  '2026-01-01T00:00:00.000Z',
  '2027-01-01T00:00:00.000Z',
  'DRAFT',
  1,
  id,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
];
const selected = process.env.QA09_OFFLINE_CASE;
if (selected && !cases.includes(selected)) throw Error('INVALID_OFFLINE_CASE');

// These wrappers exist only in this test process. No socket, server, SQL cache or runtime switch.
for (const detailed of selected ? [false] : [false, true])
  for (const name of cases) {
    const run = !selected || selected === name ? test : test.skip;
    run(`offline public contract boundaries ${name} detailed=${detailed}`, async () => {
      const accountRaw = name.startsWith('raw-'),
        fail = name === 'raw-reject' || name === 'raw-invalid';
      const delayMs = name.endsWith('-wait') ? 30 : 0,
        resultCpuMs = name.endsWith('-result') ? 20 : 0;
      let active: Record<string, number> | undefined;
      const counts = { checkout: 0, release: 0, begin: 0, commit: 0, rollback: 0, account: 0, contract: 0, dispose: 0 };
      const release = () => counts.release++;
      const driver = Object.assign(new EventEmitter(), {
        release,
        async query(config: { text: string }) {
          if (config.text === 'BEGIN') counts.begin++;
          if (config.text === 'COMMIT') counts.commit++;
          if (config.text === 'ROLLBACK') counts.rollback++;
          if (!config.text.startsWith('SELECT')) return { rows: [], fields: [], rowCount: 0 };
          if (!active) {
            counts.account++;
            return { rows: [], fields: [], rowCount: 0 };
          }
          counts.contract++;
          active.pgEntered = performance.now();
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          if (name === 'raw-reject') throw Object.assign(Error('CONTROLLED_DRIVER_FAILURE'), { code: '40001' });
          active.resultReady = performance.now();
          return {
            rows: [values],
            rowCount: 1,
            get fields() {
              active!.fieldsRead = performance.now();
              const end = performance.now() + resultCpuMs;
              while (performance.now() < end) {
                /* controlled result-access CPU, never a measured decoder */
              }
              active!.fieldsReady = performance.now();
              return names.map((column, i) => ({
                name: column,
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
      const rootQuery = vi.spyOn(Pool.prototype, 'query').mockImplementation(async () => {
        counts.account++;
        return { rows: [], fields: [], rowCount: 0 } as never;
      });
      const endPool = vi.spyOn(Pool.prototype, 'end').mockImplementation(async () => {
        counts.dispose++;
      });
      const originalConnect = ObservedPrismaPg.prototype.connect;
      const adapter = vi.spyOn(ObservedPrismaPg.prototype, 'connect').mockImplementation(async function (
        this: ObservedPrismaPg,
      ) {
        const port = await originalConnect.call(this),
          start = port.startTransaction.bind(port);
        port.startTransaction = async (...args) => {
          const tx = await start(...args),
            query = tx.queryRaw.bind(tx);
          tx.queryRaw = async (q) => {
            if (active) active.adapterEntered = performance.now();
            try {
              return await query(q);
            } finally {
              if (active) active.adapterSettled = performance.now();
            }
          };
          return tx;
        };
        return port;
      });
      const oldPool = process.env.FDP_DB_POOL_MAX;
      process.env.FDP_DB_POOL_MAX = '1';
      const candidate = createAdminPreconnectCandidate(
        'postgresql://offline:offline@invalid.invalid:1/offline',
        detailed,
      );
      const client = candidate.client.$extends({
        query: {
          contract: {
            findFirst({ args, query }) {
              active!.publicQueryEntered = performance.now();
              const pending = query(args);
              active!.publicQueryReturned = performance.now();
              return pending;
            },
          },
        },
      });
      const samples: Record<string, unknown>[] = [];
      try {
        await candidate.prepareAuthenticated();
        const accountStarted = performance.now();
        assert.isNull(await readAuthenticatedAccount(candidate.client as never, id, accountRaw));
        const accountMs = performance.now() - accountStarted;
        for (let index = 0; index < (fail ? 1 : 3); index++) {
          const marks: Record<string, number> = {},
            rows: Record<string, unknown>[] = [];
          active = marks;
          let result: unknown,
            failure = false;
          try {
            result = await withDataPathTrace(
              {
                lambdaRequestId: `offline-${name}-${index}`,
                gatewayRequestId: `offline-${name}-${index}`,
                operationId: 'updateContract',
              },
              () =>
                client.$transaction((tx) =>
                  observeContractLoad(() =>
                    tx.contract.findFirst({
                      where: name === 'raw-invalid' ? ({ invalidOfflineField: true } as never) : { id },
                    }),
                  ),
                ),
              (r) => rows.push(r),
            );
          } catch {
            failure = true;
          }
          active = undefined;
          assert.equal(failure, fail);
          if (!fail) {
            assert.equal((result as { id: string }).id, id);
            assert.equal((result as { version: number }).version, 1);
            assert.isTrue((result as { startAt: Date }).startAt instanceof Date);
            assert.equal(
              validateContractLoadSplit(
                rows.filter((r) => r.event === 'data-path.phase.completed'),
                rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
                true,
              )?.gate,
              'PASS',
            );
            if (detailed)
              assert.equal(
                validateContractLoadDetail(
                  rows.filter((r) => r.event === 'data-path.phase.completed'),
                  rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
                  true,
                )?.gate,
                'PASS',
              );
            const ordered = [
              'publicQueryEntered',
              'publicQueryReturned',
              'adapterEntered',
              'pgEntered',
              'resultReady',
              'fieldsRead',
              'fieldsReady',
              'adapterSettled',
            ];
            assert.isTrue(
              ordered.every((key, i) => Number.isFinite(marks[key]) && (!i || marks[key]! >= marks[ordered[i - 1]!]!)),
            );
            if (delayMs) assert.isAtLeast(marks.resultReady! - marks.pgEntered!, delayMs - 2);
            if (resultCpuMs) assert.isAtLeast(marks.fieldsReady! - marks.fieldsRead!, resultCpuMs - 1);
          }
          if (!detailed) assert.isFalse(rows.some((r) => r.phase === 'contract-load-driver-pg'));
          if (detailed && fail)
            assert.throws(() =>
              validateContractLoadDetail(
                rows.filter((r) => r.event === 'data-path.phase.completed'),
                rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
                true,
              ),
            );
          assert.strictEqual(driver.release, release);
          samples.push({
            index,
            firstContractForClient: index === 0,
            expectedFailure: fail,
            failure,
            marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
            phases: rows,
          });
        }
        assert.equal(counts.account, 1);
        assert.equal(counts.contract, name === 'raw-invalid' ? 0 : fail ? 1 : 3);
        assert.equal(counts.checkout, 1 + (fail ? 1 : 3)); // preconnect plus the original transactions
        assert.equal(counts.release, counts.checkout);
        assert.equal(counts.begin, fail ? 1 : 3);
        assert.equal(counts.commit, fail ? 0 : 3);
        assert.equal(counts.rollback, fail ? 1 : 0);
        await candidate.client.$disconnect();
        assert.equal(counts.dispose, 1);
        const receipt = {
          gate: 'PASS',
          source: 'REAL_PRISMA_ADAPTER_CONTROLLED_PG_ONLY',
          case: name,
          accountRaw,
          accountMs,
          delayMs,
          resultCpuMs,
          poolMax: 1,
          counts,
          samples,
          serverExecutionIsolated: false,
          compilerOnlyAttribution: false,
          targetEquivalent: false,
          p95Accepted: false,
          fullQa09Accepted: false,
        };
        const serialized = JSON.stringify(receipt);
        assert.notInclude(serialized, 'postgresql');
        assert.notInclude(serialized, 'SELECT');
        if (selected && process.env.QA09_OFFLINE_OUTPUT) {
          assert.isFalse(existsSync(process.env.QA09_OFFLINE_OUTPUT));
          writeFileSync(process.env.QA09_OFFLINE_OUTPUT, JSON.stringify(receipt, null, 2) + '\n');
        }
      } finally {
        await candidate.client.$disconnect();
        if (oldPool === undefined) delete process.env.FDP_DB_POOL_MAX;
        else process.env.FDP_DB_POOL_MAX = oldPool;
        adapter.mockRestore();
        connect.mockRestore();
        rootQuery.mockRestore();
        endPool.mockRestore();
      }
    });
  }
