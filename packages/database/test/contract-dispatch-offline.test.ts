import { test, assert, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { CpuProbe, monoUs } from './helpers/contract-cpu-probe.js';
import { EntryOutputProbe } from './helpers/contract-entry-output-probe.js';
import { DispatchProbe } from './helpers/contract-dispatch-probe.js';
import { dispatchCases, validateDispatchReceipt } from '../../../scripts/qa09-contract-dispatch-proof.mjs';
import { createRedactingLogger } from '@fdp/observability';
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

const hook = vi.hoisted(() => ({
  probe: undefined as CpuProbe | undefined,
  dispatch: undefined as DispatchProbe | undefined,
  name: '',
  activeLoad: false,
}));
// Test-only exported repository ports; never patch Prisma compiler/private entry points.
vi.mock('@fdp/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@fdp/observability')>();
  return {
    ...original,
    captureDataPathBoundary() {
      const before = monoUs();
      const cpu = process.cpuUsage();
      const value = original.captureDataPathBoundary();
      const after = monoUs();
      hook.probe?.capture(value, before, after);
      hook.dispatch?.capture(value, before, after, cpu);
      return value;
    },
    recordContractObserverBoundary(...args: Parameters<typeof original.recordContractObserverBoundary>) {
      if (args[1] === 'DRIVER_DISPATCH') hook.dispatch?.mark('dispatch', args[2]);
      return original.recordContractObserverBoundary(...args);
    },
    observeContractPublicCall<T>(scope: Parameters<typeof original.observeContractPublicCall>[0], work: () => T): T {
      hook.dispatch?.mark('public-bridge-enter');
      hook.dispatch?.burn('observer-public-bridge', hook.name === 'public-bridge-cpu');
      let calls = 0;
      let owned: T | undefined;
      const returned = original.observeContractPublicCall(scope, () => {
        calls++;
        hook.dispatch?.mark('callback-enter');
        if (hook.name === 'public-reject') throw Object.assign(Error('CONTROLLED_FAILURE'), { code: '40001' });
        owned = work();
        return owned;
      });
      if (calls !== 1 || returned !== owned) throw Error('ORIGINAL_PROMISE_IDENTITY_REQUIRED');
      return returned;
    },
    beginDataPathPhase(...args: Parameters<typeof original.beginDataPathPhase>) {
      if (args[0] === 'contract-load-await-after-queue') {
        hook.dispatch?.mark('checkpoint', args[1]?.startBoundary);
        hook.dispatch?.burn('checkpoint-phase-setup', hook.name === 'checkpoint-cpu');
      }
      if (args[0] === 'contract-load-driver-query')
        hook.dispatch?.burn('repository-driver-setup', hook.name === 'driver-setup-cpu');
      const finish = original.beginDataPathPhase(...args);
      if (args[0] === 'contract-load-await-after-queue') hook.dispatch?.mark('checkpoint-phase-ready');
      const span = hook.probe?.begin(args[0], args[1]?.startBoundary);
      return (...end: Parameters<typeof finish>) => {
        hook.probe?.finish(span, end[2], end[0] !== undefined);
        const value = finish(...end);
        if (args[0] === 'contract-load-await-queue' && end[1] === 'MICROTASK_CHECKPOINT')
          hook.dispatch?.mark('checkpoint-return');
        return value;
      };
    },
  };
});
vi.mock('../src/contract-load-observation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/contract-load-observation.js')>();
  return {
    ...original,
    observeContractLoadDriver<T>(work: () => Promise<T>, transactional: boolean) {
      if (!hook.activeLoad) return original.observeContractLoadDriver(work, transactional);
      hook.dispatch?.burn('engine-dispatch-gap', hook.name === 'pre-driver-cpu');
      if (hook.name === 'pre-driver-reject') throw Object.assign(Error('CONTROLLED_FAILURE'), { code: '40001' });
      return original.observeContractLoadDriver(work, transactional);
    },
  };
});
const cases = Object.keys(dispatchCases);
const selected = process.env.QA09_DISPATCH_CASE;
if (selected && !cases.includes(selected)) throw Error('INVALID_DISPATCH_CASE');
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
    `offline checkpoint and driver prefix ownership ${name}`,
    async () => {
      const native = false,
        enabled = name !== 'default-off',
        failureExpected = name.endsWith('reject');
      const dispatchConfig = dispatchCases[name]!;
      const config = {
        profile: dispatchConfig.profile === true,
        waitMs: 0,
        checkpointCpuMs: 0,
        adapterCpuMs: 0,
        pgCpuMs: 0,
        fieldsCpuMs: 0,
        resumeCpuMs: 0,
      };
      const delayMs = config.waitMs,
        resultCpuMs = config.fieldsCpuMs;
      const probe = new CpuProbe(config);
      hook.probe = probe;
      const boundaryEnabled = !['default-off', 'reference'].includes(name);
      const entry = new EntryOutputProbe(boundaryEnabled);
      const dispatch = new DispatchProbe(boundaryEnabled);
      hook.dispatch = dispatch;
      hook.name = name;
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
          if (stage === 'load') probe.pgSubmit();
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
              if (stage === 'load') probe.fields();
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
      const originalConnect = PrismaPg.prototype.connect;
      const adapter = vi.spyOn(PrismaPg.prototype, 'connect').mockImplementation(async function (this: PrismaPg) {
        const port = await originalConnect.call(this);
        const start = port.startTransaction.bind(port);
        port.startTransaction = async (...args) => {
          const tx = await start(...args);
          const query = tx.queryRaw;
          tx.queryRaw = function (...q) {
            if (stage !== 'load') return query.apply(this, q);
            dispatch.mark('adapter-port-enter');
            let owned: ReturnType<typeof query> | undefined;
            const returned = entry.callPublic(() => {
              owned = query.apply(this, q);
              return owned;
            });
            assert.strictEqual(returned, owned);
            return returned!;
          };
          return tx;
        };
        return port;
      });
      const old = process.env.FDP_DB_POOL_MAX;
      process.env.FDP_DB_POOL_MAX = '1';
      const owner = createAdminPreconnectCandidate(
        'postgresql://offline:offline@invalid.invalid:1/offline',
        enabled,
        enabled,
      );
      const samples: Record<string, unknown>[] = [];
      try {
        await probe.start();
        await probe.measure('prepare', () => owner.prepareAuthenticated());
        stage = 'account';
        assert.isNull(
          await probe.measure('account', () => readAuthenticatedAccount(owner.client as never, 'offline-sub', true)),
        );
        for (let index = 0; index < (failureExpected ? 1 : 3); index++) {
          const rows: Record<string, unknown>[] = [],
            windowsMs: Record<string, number> = {},
            windowsCpuUs: Record<string, number> = {};
          probe.sample(index, `dispatch-${name}-${index}`);
          entry.sample(`dispatch-${name}-${index}`, `dispatch-L-${name}-${index}`);
          dispatch.sample(`dispatch-${name}-${index}`);
          let delivered = 0;
          const targetPhase =
            name === 'checkpoint-output-cpu' ? 'contract-load-await-queue' : 'contract-load-await-after-queue';
          let selectedOutput = false;
          const logger = createRedactingLogger({
            info() {
              delivered++;
            },
            debug() {},
            warn() {},
            error() {},
          });
          const output = entry.wrapOutput((row) => {
            rows.push(row);
            if (row.phase === targetPhase && !selectedOutput) {
              selectedOutput = true;
              dispatch.burn(
                name === 'checkpoint-output-cpu' ? 'checkpoint-output-return' : 'repository-driver-setup',
                name === 'checkpoint-output-cpu' || name === 'prefix-output-cpu',
              );
            }
            return logger.info(JSON.stringify(row));
          });
          let failed = false,
            expectedFailureMatched = false;
          try {
            await withDataPathTrace(
              {
                lambdaRequestId: `dispatch-L-${name}-${index}`,
                gatewayRequestId: `dispatch-${name}-${index}`,
                operationId: 'updateContract',
              },
              () =>
                owner.client.$transaction(async (tx) => {
                  const measure = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
                    stage = key;
                    hook.activeLoad = key === 'load';
                    const started = performance.now(),
                      cpu = process.cpuUsage();
                    try {
                      return await work();
                    } finally {
                      hook.activeLoad = false;
                      const usage = process.cpuUsage(cpu);
                      windowsCpuUs[key] = usage.user + usage.system;
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
              output,
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
          if (!['pre-driver-reject', 'public-reject', 'pg-reject', 'validation-reject'].includes(name)) {
            if (enabled) {
              assert.equal(validateContractAwaitCheckpoint(phases, ownership, true)?.gate, 'PASS');
              assert.equal(validateContractPublicBoundaries(phases, ownership, true)?.gate, 'PASS');
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
            windowsCpuUs,
            observations: rows,
            spans: probe.endSample(),
            entryOutput: entry.snapshot(),
            dispatch: dispatch.snapshot(),
            delivered,
          });
        }
        const n = samples.length;
        assert.equal(counts.account, 1);
        assert.equal(counts.checkout, n + 1);
        assert.equal(counts.release, counts.checkout);
        assert.equal(counts.begin, n);
        assert.equal(counts.commit, failureExpected ? 0 : n);
        assert.equal(counts.rollback, failureExpected ? 1 : 0);
        assert.equal(counts.load, ['pre-driver-reject', 'public-reject', 'validation-reject'].includes(name) ? 0 : n);
        assert.equal(counts.update, failureExpected && !['update-reject', 'audit-reject'].includes(name) ? 0 : n);
        assert.equal(counts.readback, failureExpected && name !== 'audit-reject' ? 0 : n);
        assert.equal(counts.audit, failureExpected && name !== 'audit-reject' ? 0 : n);
        await owner.client.$disconnect();
        assert.equal(counts.dispose, 1);
        counts.pools = pools.size;
        assert.equal(counts.pools, 1);
        assert.equal(counts.network, 0);
        const profile = await probe.stop();
        const receipt = {
          kind: 'qa09-offline-contract-dispatch/v1',
          dispatchConfig,
          extraQueries: 0,
          enabled,
          forcedYields: 0,
          gate: 'PASS',
          source: 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
          case: name,
          native,
          accountNative: true,
          config,
          probe: probe.receipt(),
          profile,
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
        validateDispatchReceipt(receipt);
        const extraQuery = structuredClone(receipt);
        extraQuery.counts.load++;
        assert.throws(() => validateDispatchReceipt(extraQuery), /DISPATCH_TRANSACTION_OWNER/);
        const wrongRequest = structuredClone(receipt);
        (wrongRequest.samples[0]!.dispatch as { requestId: string }).requestId = 'foreign';
        assert.throws(() => validateDispatchReceipt(wrongRequest), /DISPATCH_REQUEST_OWNER/);
        assert.notInclude(JSON.stringify(receipt), 'postgresql://');
        assert.notInclude(JSON.stringify(receipt), 'SELECT');
        if (selected && process.env.QA09_DISPATCH_OUTPUT) {
          assert.isFalse(existsSync(process.env.QA09_DISPATCH_OUTPUT));
          writeFileSync(process.env.QA09_DISPATCH_OUTPUT, JSON.stringify(receipt, null, 2) + '\n');
        }
      } finally {
        await owner.client.$disconnect();
        if (old === undefined) delete process.env.FDP_DB_POOL_MAX;
        else process.env.FDP_DB_POOL_MAX = old;
        await probe.close();
        hook.probe = undefined;
        hook.dispatch = undefined;
        hook.name = '';
        hook.activeLoad = false;
        adapter.mockRestore();
        network.mockRestore();
        connect.mockRestore();
        root.mockRestore();
        end.mockRestore();
      }
    },
  );
