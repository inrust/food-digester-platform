import { test, assert, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { writeFileSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createContractWindowProbe } from './helpers/contract-window-probe.js';
import { windowCases, summarizeContractWindows } from '../../../scripts/qa09-contract-windows-proof.mjs';
import { withDataPathTrace } from '@fdp/observability';
import { createAdminPreconnectCandidate } from '../src/client.js';
import { observeContractLoad } from '../src/contract-load-observation.js';
import { readAuthenticatedAccount } from '../../../apps/cloud-api/src/admin/user/account-read-candidate.js';
import { readContractForUpdate } from '../../../apps/cloud-api/src/admin/contract/load-candidate.js';
import { validateContractAwaitCheckpoint } from '../../../scripts/qa09-contract-load-detail-proof.mjs';

const cases = Object.keys(windowCases);
const selected = process.env.QA09_WINDOWS_CASE;
if (selected && !cases.includes(selected)) throw Error('INVALID_WINDOWS_CASE');
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
  (selected && selected !== name ? test.skip : test)(`bounded offline contract public windows ${name}`, async () => {
    const enabled = name !== 'off',
      control = windowCases[name as keyof typeof windowCases] as Record<string, number | string>;
    const failure = control.failure,
      failureExpected = Boolean(failure);
    const burn = (key: string) => {
      if (stage !== 'load') return;
      const until = performance.now() + Number(control[key] ?? 0);
      while (performance.now() < until) {
        /* controlled CPU, never a decoder/compiler attribution */
      }
    };
    const wait = async (key: string) => {
      if (stage === 'load' && control[key]) await new Promise((r) => setTimeout(r, Number(control[key])));
    };
    let active: ReturnType<typeof createContractWindowProbe> | undefined;
    const mark = (key: string) => {
      if (stage === 'load') active?.mark(key);
    };
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
      networkAttempts: 0,
      pools: 0,
    };
    const network = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
      counts.networkAttempts++;
      throw Error('OFFLINE_NETWORK_FORBIDDEN');
    });
    const error = Object.assign(Error('CONTROLLED_FAILURE'), { code: '40001' });
    const release = () => counts.release++;
    const driver = Object.assign(new EventEmitter(), {
      release,
      query(config: { text: string; values?: unknown[] }) {
        const sql = config.text.trimStart();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
          counts[sql.toLowerCase() as 'begin' | 'commit' | 'rollback']++;
          return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
        }
        if (stage === 'account') {
          counts.account++;
          return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
        }
        assert.include(['load', 'update', 'readback', 'audit'], stage);
        counts[stage as 'load' | 'update' | 'readback' | 'audit']++;
        if ((stage === 'update' && failure === 'update') || (stage === 'audit' && failure === 'audit'))
          return Promise.reject(error);
        if (stage === 'update') return Promise.resolve({ rows: [], fields: [], rowCount: 1 });
        if (stage === 'audit')
          return Promise.resolve({ rows: [['offline-audit']], fields: [{ name: 'id', dataTypeID: 25 }], rowCount: 1 });
        mark('pg-enter');
        burn('pgSubmit');
        mark('pg-return');
        return (async () => {
          await wait('pgWait');
          mark('pg-ready');
          if (stage === 'load' && failure === 'pg') throw error;
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
              mark('decode-enter');
              burn('decodeCpu');
              if (stage === 'load' && failure === 'decode') throw error;
              mark('decode-exit');
              return fields.map((field, i) => ({
                name: field,
                dataTypeID: i === 8 ? 23 : [5, 6, 10, 11].includes(i) ? 1184 : 25,
              }));
            },
          };
        })();
      },
    });
    const pools = new Set<Pool>();
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
    const originalConnect = PrismaPg.prototype.connect;
    const adapter = vi.spyOn(PrismaPg.prototype, 'connect').mockImplementation(async function (this: PrismaPg) {
      const port = await originalConnect.call(this),
        start = port.startTransaction.bind(port);
      port.startTransaction = async (...args) => {
        const tx = await start(...args),
          query = tx.queryRaw.bind(tx);
        tx.queryRaw = async (q) => {
          if (stage !== 'load') return query(q);
          mark('adapter-enter');
          const pending = query(q);
          mark('adapter-call-return');
          const value = await pending;
          mark('adapter-resume');
          burn('adapterCpu');
          mark('adapter-return');
          return value;
        };
        return tx;
      };
      return port;
    });
    const old = process.env.FDP_DB_POOL_MAX;
    process.env.FDP_DB_POOL_MAX = '1';
    const owner = createAdminPreconnectCandidate('postgresql://offline:offline@invalid.invalid:1/offline', enabled);
    // Fixed offline scheduling in BOTH groups; this is deliberately not target-equivalent.
    const client = owner.client.$extends({
      query: {
        contract: {
          async findFirst({ args, query }) {
            if (stage !== 'load') return query(args);
            mark('extension-enter');
            await Promise.resolve();
            await Promise.resolve();
            mark('await-enter');
            burn('awaitCpu');
            await wait('awaitWait');
            if (failure === 'await') throw error;
            mark('await-exit');
            const pending = query(args);
            mark('extension-query-return');
            const value = await pending;
            mark('extension-resume');
            burn('resultCpu');
            if (failure === 'result') throw error;
            mark('extension-return');
            return value;
          },
        },
      },
    });
    const samples: Record<string, unknown>[] = [];
    try {
      await owner.prepareAuthenticated();
      stage = 'account';
      assert.isNull(await readAuthenticatedAccount(owner.client as never, 'offline-sub', true));
      for (let index = 0; index < (failureExpected ? 1 : 3); index++) {
        const rows: Record<string, unknown>[] = [],
          windowsMs: Record<string, number> = {};
        active = createContractWindowProbe(`windows-${name}-${index}`, enabled);
        let failed = false,
          expectedFailureMatched = false;
        try {
          await withDataPathTrace(
            {
              lambdaRequestId: `windows-${name}-${index}`,
              gatewayRequestId: `windows-${name}-${index}`,
              operationId: 'updateContract',
            },
            () =>
              client.$transaction(async (tx) => {
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
                  observeContractLoad(async () => {
                    mark('load-enter');
                    const value = await readContractForUpdate(tx as never, id, false);
                    mark('caller-resume');
                    burn('callerCpu');
                    mark('load-return');
                    return value;
                  }),
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
          // Real Prisma wraps driver errors but preserves their code; extension failures stay identical.
          expectedFailureMatched = ['await', 'result'].includes(String(failure))
            ? caught === error
            : (caught as { code?: string })?.code === error.code;
        }
        assert.equal(failed, failureExpected);
        const phases = rows.filter((r) => r.event === 'data-path.phase.completed'),
          ownership = rows.filter((r) => r.event === 'data-path.contract-load.ownership');
        if (enabled && !['await', 'pg', 'decode', 'result'].includes(String(failure)))
          assert.equal(validateContractAwaitCheckpoint(phases, ownership, true)?.gate, 'PASS');
        if (failure) assert.isTrue(expectedFailureMatched);
        samples.push({
          index,
          firstForClient: index === 0,
          failed,
          expectedFailureMatched,
          windowsMs,
          marks: active.marks,
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
      await owner.client.$disconnect();
      assert.equal(counts.dispose, 1);
      counts.pools = pools.size;
      assert.equal(counts.pools, 1);
      const receipt = {
        kind: 'qa09-offline-contract-windows/v1',
        gate: 'PASS',
        source: 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
        case: name,
        enabled,
        control,
        poolMax: 1,
        fixedMicrotaskYields: 2,
        counts,
        samples,
        auditReturnProjection: 'ID_ONLY_OFFLINE',
        targetEquivalent: false,
        compilerOnlyAttribution: false,
        serverExecutionIsolated: false,
        p95Accepted: false,
        fullQa09Accepted: false,
      };
      assert.equal(summarizeContractWindows(receipt).length, samples.length);
      assert.notInclude(JSON.stringify(receipt), 'postgresql');
      assert.notInclude(JSON.stringify(receipt), 'SELECT');
      if (selected && process.env.QA09_WINDOWS_OUTPUT) {
        assert.isFalse(existsSync(process.env.QA09_WINDOWS_OUTPUT));
        writeFileSync(process.env.QA09_WINDOWS_OUTPUT, JSON.stringify(receipt, null, 2) + '\n');
      }
    } finally {
      await owner.client.$disconnect();
      if (old === undefined) delete process.env.FDP_DB_POOL_MAX;
      else process.env.FDP_DB_POOL_MAX = old;
      network.mockRestore();
      adapter.mockRestore();
      connect.mockRestore();
      root.mockRestore();
      end.mockRestore();
    }
  });
