import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function summarizeProfile(profile, { constructorName = 'QueryCompiler' } = {}) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
  const totals = { compilerConstructorUs: 0, compileQueryUs: 0, wasmOtherUs: 0, otherUs: 0 };
  for (let i = 0; i < (profile.samples ?? []).length; i++) {
    let id = profile.samples[i],
      category = 'otherUs',
      wasm = false;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const f = nodes.get(id)?.callFrame;
      wasm ||= f?.url?.startsWith('wasm://') === true;
      if (
        f?.url?.includes('query_compiler_fast_bg.postgresql') &&
        [constructorName, 'constructor'].includes(f.functionName)
      ) {
        category = 'compilerConstructorUs';
        break;
      }
      if (f?.url?.includes('query_compiler_fast_bg.postgresql') && f.functionName === 'compile') {
        category = 'compileQueryUs';
        break;
      }
      id = parents.get(id);
    }
    if (category === 'otherUs' && wasm) category = 'wasmOtherUs';
    totals[category] += profile.timeDeltas?.[i] ?? 0;
  }
  return {
    ...totals,
    sampleCount: profile.samples?.length ?? 0,
    boundaries:
      'Sample stack attribution; not exact CPU duration or AWS profiling. Child samples included by ancestry; categories are exclusive.',
  };
}
export async function diagnosePreparation(mode) {
  if (!['lazy', 'prepared', 'parameterized'].includes(mode)) throw Error('INVALID_DIAGNOSTIC_MODE');
  if (process.env.FDP_DB_POOL_MAX !== '1') throw Error('OFFLINE_POOL1_REQUIRED');
  const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
  const { Pool } = require('pg');
  const originalConnect = Pool.prototype.connect;
  let checkouts = 0,
    queries = 0,
    releases = 0;
  const spans = [],
    pools = new Set(),
    poolMaxima = new Set();
  let activeLeases = 0,
    peakLeases = 0;
  const originalModule = WebAssembly.Module,
    originalInstance = WebAssembly.Instance;
  const timed = (name, work) => {
    const start = performance.now(),
      cpu = process.cpuUsage();
    try {
      return work();
    } finally {
      const used = process.cpuUsage(cpu);
      spans.push({ name, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
    }
  };
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  WebAssembly.Module = new Proxy(originalModule, {
    construct: (t, a) => timed('wasm-module', () => Reflect.construct(t, a)),
  });
  WebAssembly.Instance = new Proxy(originalInstance, {
    construct: (t, a) => timed('wasm-instance', () => Reflect.construct(t, a)),
  });
  Pool.prototype.connect = function (callback) {
    pools.add(this);
    poolMaxima.add(this.options.max);
    checkouts++;
    activeLeases++;
    peakLeases = Math.max(peakLeases, activeLeases);
    const release = () => {
      releases++;
      activeLeases--;
    };
    const driver = Object.assign(new EventEmitter(), {
      release,
      query(_config, _values, cb) {
        queries++;
        const value = { rows: [], fields: [], rowCount: 0 };
        if (cb) return cb(undefined, value);
        return Promise.resolve(value);
      },
    });
    if (callback) return callback(undefined, driver, release);
    return Promise.resolve(driver);
  };
  const session = new Session();
  session.connect();
  const post = (name, args = {}) =>
    new Promise((res, rej) => session.post(name, args, (e, v) => (e ? rej(e) : res(v))));
  const compilerModule = await import(
    pathToFileURL(require.resolve('@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs')).href
  );
  const originalCompile = compilerModule.QueryCompiler.prototype.compile;
  compilerModule.QueryCompiler.prototype.compile = function (...args) {
    return timed('compile-query', () => originalCompile.apply(this, args));
  };
  let client;
  try {
    const { createPrismaClient } = await import('../packages/database/src/client.ts');
    const { readAuthenticatedAccount } = await import('../apps/cloud-api/src/admin/user/account-read-candidate.ts');
    const { withDataPathTrace } = await import(pathToFileURL(require.resolve('@fdp/observability')).href);
    const phases = [];
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    const started = performance.now();
    client = createPrismaClient('postgresql://local:local@localhost:5432/test');
    const constructionMs = performance.now() - started;
    const beforePreparation = { checkouts, queries };
    let prepareMs = 0;
    if (mode !== 'lazy') {
      const start = performance.now();
      await client.$connect();
      prepareMs = performance.now() - start;
    }
    const beforeQuery = { checkouts, queries };
    const queryTimes = [];
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      const value = await withDataPathTrace(
        {},
        () => readAuthenticatedAccount(client, 'local-diagnostic-only', mode === 'parameterized'),
        (r) => phases.push(r),
      );
      if (value !== null) throw Error('FAKE_DRIVER_RESULT_INVALID');
      queryTimes.push(performance.now() - start);
    }
    const { profile } = await post('Profiler.stop');
    const compilerRuntime = await import(
      pathToFileURL(require.resolve('@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs')).href
    );
    const constructorName = compilerRuntime.QueryCompiler.name;
    await client.$disconnect();
    client = null;
    await new Promise((res) => setTimeout(res, 5));
    const noPreQueryCheckout =
      beforePreparation.checkouts === 0 && beforeQuery.checkouts === 0 && beforeQuery.queries === 0;
    return {
      source: 'LOCAL_FRESH_PROCESS_REAL_PRISMA_FAKE_PG_NO_NETWORK',
      mode,
      gate:
        noPreQueryCheckout &&
        checkouts === 2 &&
        queries === 2 &&
        releases === 2 &&
        activeLeases === 0 &&
        peakLeases === 1 &&
        pools.size === 1 &&
        poolMaxima.size === 1 &&
        poolMaxima.has(1)
          ? 'PASS'
          : 'FAIL',
      constructionMs,
      prepareMs,
      firstQueryMs: queryTimes[0],
      secondQueryMs: queryTimes[1],
      preparePlusFirstQueryMs: prepareMs + queryTimes[0],
      beforePreparation,
      beforeQuery,
      counts: {
        checkouts,
        queries,
        releases,
        activeLeases,
        peakLeases,
        pools: pools.size,
        poolMaxima: [...poolMaxima],
      },
      noPreQueryCheckout,
      wasmSpans: spans,
      compilerConstructorName: constructorName,
      profileSummary: summarizeProfile(profile, { constructorName }),
      profile,
      phases: phases.map((r) => ({
        phase: r.phase,
        durationMs: r.durationMs,
        outcome: r.outcome,
        completionBoundary: r.completionBoundary ?? null,
        processCpuUserUs: r.processCpuUserUs ?? null,
        processCpuSystemUs: r.processCpuSystemUs ?? null,
      })),
      eventLoopMaxMs: histogram.max / 1e6,
      node: process.version,
      architecture: process.arch,
      awsAccepted: false,
      p95Accepted: false,
    };
  } finally {
    await client?.$disconnect();
    Pool.prototype.connect = originalConnect;
    compilerModule.QueryCompiler.prototype.compile = originalCompile;
    WebAssembly.Module = originalModule;
    WebAssembly.Instance = originalInstance;
    histogram.disable();
    session.disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--child') {
    const result = await diagnosePreparation(process.argv[3]);
    console.log(JSON.stringify(result));
  } else {
    const output = process.argv[2];
    if (!output || process.argv.length !== 3) throw Error('OUTPUT_DIRECTORY_REQUIRED');
    mkdirSync(output, { recursive: true });
    const rows = [];
    for (const mode of ['lazy', 'prepared', 'parameterized'])
      for (let i = 1; i <= 3; i++) {
        const raw = execFileSync(process.execPath, ['--import', 'tsx', process.argv[1], '--child', mode], {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const row = JSON.parse(raw);
        writeFileSync(join(output, `${mode}-${i}.json`), JSON.stringify(row, null, 2) + '\n');
        const { profile: _profile, ...safe } = row;
        rows.push({ index: i, ...safe });
      }
    const sources = [
      'scripts/qa09-prisma-preparation-diagnostic.mjs',
      'packages/database/src/client.ts',
      'apps/cloud-api/src/admin/user/account-read-candidate.ts',
      'packages/database/src/client-preparation.ts',
      'packages/database/src/observed-pg.ts',
      'packages/database/src/generated/internal/class.ts',
      'node_modules/@prisma/client/runtime/client.js.map',
    ].map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
    const result = {
      gate: rows.every((r) => r.gate === 'PASS') ? 'PASS' : 'FAIL',
      scope: 'LOCAL_DIAGNOSTIC_NOT_AWS_OPTIMIZATION_ACCEPTANCE',
      rows,
      sources,
      connectionBudgetChanged: false,
      awsAccepted: false,
      p95Accepted: false,
    };
    writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ gate: result.gate, runs: rows.length }));
  }
}
