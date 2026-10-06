import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProfile } from './qa09-prisma-preparation-diagnostic.mjs';
import { parseCurlMetrics, runCurlTransport } from './qa09-curl-transport-diagnostic.mjs';
test('CPU ancestry attributes minified constructor and compile samples exclusively', () => {
  const frame = (id, functionName, url, children = []) => ({ id, callFrame: { functionName, url }, children });
  const p = {
    nodes: [
      frame(1, 'F', 'query_compiler_fast_bg.postgresql.mjs', [2]),
      frame(2, 'wasm-fn', 'wasm://x'),
      frame(3, 'compile', 'query_compiler_fast_bg.postgresql.mjs', [4]),
      frame(4, 'wasm-fn', 'wasm://x'),
      frame(5, 'other', 'file://local'),
    ],
    samples: [2, 4, 5],
    timeDeltas: [1000, 2000, 3000],
  };
  const r = summarizeProfile(p, { constructorName: 'F' });
  assert.equal(r.compilerConstructorUs, 1000);
  assert.equal(r.compileQueryUs, 2000);
  assert.equal(r.otherUs, 3000);
  assert.equal(r.wasmOtherUs, 0);
});
test('curl metrics differences preserve boundaries and reject bad ordering or nonfinite values', () => {
  assert.deepEqual(parseCurlMetrics('401 0 1 .001 .501 .801 1.101 1.102'), {
    status: 401,
    sslVerifyResult: 0,
    connections: 1,
    dnsMs: 1,
    tcpMs: 500,
    tlsMs: 300,
    responseWaitMs: 300,
    bodyAfterFirstByteMs: 1,
    totalMs: 1102,
  });
  for (const x of ['401 0 1 .2 .1 .3 .4 .5', '401 0 1 0 1 2 3 NaN', '401 0 1 0 1'])
    assert.throws(() => parseCurlMetrics(x));
});
test('curl probes are six bounded verified GETs with no credential/config/retry path; proxy prevents dispatch', async () => {
  const calls = [];
  const run = async (name, args, options) => {
    calls.push({ name, args, options });
    return { stdout: '401 0 1 .001 .501 .801 1.101 1.102' };
  };
  const r = await runCurlTransport({ run, env: {} });
  assert.equal(r.gate, 'PASS');
  assert.equal(r.source, 'CONTROLLED_TEST_ONLY');
  assert.equal(calls.length, 6);
  for (const c of calls) {
    assert.equal(c.args[0], '-q');
    assert.ok(c.args.includes('--http1.1'));
    assert.ok(!c.args.some((x) => ['-k', '--insecure', '--retry', '--user', '--header', '--data'].includes(x)));
    assert.equal(c.options.timeout, 25000);
  }
  assert.equal(calls.filter((c) => c.args.includes('--ipv4')).length, 3);
  assert.equal((await runCurlTransport({ run, env: { HTTPS_PROXY: 'private-value' } })).gate, 'NOT_RUN');
  assert.equal(calls.length, 6);
});
test('curl failures retain siblings and discard raw error text', async () => {
  let i = 0;
  const r = await runCurlTransport({
    env: {},
    run: async () => {
      if (++i === 2) throw Error('PRIVATE_VALUE');
      return { stdout: '401 0 1 .001 .501 .801 1.101 1.102' };
    },
  });
  assert.equal(r.rows.length, 6);
  assert.equal(r.gate, 'PARTIAL');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_VALUE'));
});
