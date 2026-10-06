import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runCold409Sampling } from './qa09-cold409-sampling.mjs';
import { validateColdSamplingReceipt, validateSamplingCorrelationLedger } from './qa09-cold409-proof.mjs';
const prefix = 'qa09-1234567890abcdef';
function fixture(fault) {
  const contracts = new Map(),
    audit = [],
    events = [];
  let inFlight = 0,
    peak = 0,
    patches = 0;
  const child = {
    prefix,
    devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    customers: [0, 1].map((i) => ({ id: randomUUID(), name: prefix + (i ? '-b' : '-a') })),
    checks: [],
    remaining: { gate: 'PASS' },
    fullQa09Accepted: false,
  };
  const ctx = {
    ...child,
    businessReceipt: child,
    save() {},
    waitForWriteQuiescence: async () => {
      events.push('grace');
      assert.equal(inFlight, 0);
    },
    async api(id, role, method, path, expected, body, headers) {
      events.push(id + ':start');
      if (method === 'POST') {
        const c = { ...body, contractId: randomUUID(), version: 1, status: 'DRAFT' };
        contracts.set(c.contractId, c);
        return { data: { ...c } };
      }
      if (method === 'PATCH') {
        patches++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, id.endsWith(':a') ? 1 : 8));
          if (fault === 'transport' && id === 'cold:1:1:a') {
            child.checks.push({ id, responseReceived: false });
            throw Error('UNKNOWN_WRITE');
          }
          const c = contracts.get(path.split('/').at(-1));
          const status = c.version === Number(headers['If-Match']) ? 200 : 409;
          const before = c.version;
          if (status === 200) {
            c.version++;
            c.name = body.name;
          }
          audit.push({
            auditId: randomUUID(),
            objectId: c.contractId,
            objectType: 'contract',
            result: status === 200 ? 'SUCCESS' : 'FAILURE',
            reason: prefix,
            requestId: fault === 'audit-id' ? 'foreign' : headers['x-amzn-RequestId'],
            beforeValue: { version: status === 200 ? before : 1 },
            afterValue: status === 200 ? { version: 2 } : null,
          });
          child.checks.push({
            id,
            status,
            responseReceived: true,
            gatewayRequestId: headers['x-amzn-RequestId'],
            errorCode: status === 409 ? 'VERSION_CONFLICT' : null,
          });
          return { data: {} };
        } finally {
          inFlight--;
          events.push(id + ':settled');
        }
      }
      if (path.includes('audit-logs?'))
        return {
          data: audit
            .filter((a) => a.objectId === new URL('https://example.invalid' + path).searchParams.get('objectId'))
            .map((a) => (fault === 'foreign-list' ? { ...a, objectId: 'foreign' } : a)),
          meta: {},
        };
      if (path.includes('audit-logs/')) return { data: audit.find((a) => a.auditId === path.split('/').at(-1)) };
      assert.equal(inFlight, 0, 'all siblings must settle before readback');
      return { data: { ...contracts.get(path.split('/').at(-1)) } };
    },
  };
  return { ctx, child, events, stats: () => ({ peak, patches }) };
}
test('two batches preserve six own contracts, six winners/conflicts and audits with a hard concurrency/request bound', async () => {
  const f = fixture();
  const r = await runCold409Sampling(f.ctx);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.coldGate, 'NOT_EVALUATED');
  assert.deepEqual(f.stats(), { peak: 6, patches: 12 });
  assert.equal(r.contracts.length, 6);
  assert.equal(r.audit.length, 12);
  assert.equal(f.child.remaining.gate, 'PASS');
  assert.equal(r.attempts.filter((a) => a.observation.status === 409).length, 6);
  f.child.gate = 'PASS';
  f.child.cleanupComplete = true;
  assert.equal(validateColdSamplingReceipt(f.child), r);
  for (const mutate of [
    (c) => {
      c.cold409Sampling.maxConcurrency = 12;
    },
    (c) => {
      c.cold409Sampling.attempts[0].state = 'DISPATCHED';
    },
    (c) => {
      c.cold409Sampling.contracts[0].customerId = 'foreign';
    },
    (c) => {
      c.cold409Sampling.audit[0].requestId = 'foreign';
    },
    (c) => {
      c.cleanupComplete = false;
    },
    (c) => {
      c.gate = 'FAIL';
    },
  ]) {
    const c = structuredClone(f.child);
    mutate(c);
    assert.throws(() => validateColdSamplingReceipt(c));
  }
});
test('unknown write drains siblings and waits for Lambda quiescence without retry or false PASS', async () => {
  const f = fixture('transport');
  const r = await runCold409Sampling(f.ctx);
  assert.equal(r.gate, 'FAIL');
  assert.equal(f.stats().patches, 6);
  assert.equal(r.unknownWriteGraceMs, 35000);
  assert.ok(f.events.indexOf('cold:1:3:b:settled') < f.events.indexOf('grace'));
  assert.ok(f.events.indexOf('grace') < f.events.indexOf('cold:1:1:after:start'));
  assert.ok(r.attempts.every((a) => a.completedAt));
});
for (const fault of ['audit-id', 'foreign-list'])
  test('audit drift fails closed: ' + fault, async () => {
    const f = fixture(fault);
    assert.equal((await runCold409Sampling(f.ctx)).gate, 'FAIL');
    if (fault === 'foreign-list') assert.ok(!f.events.some((e) => e.startsWith('cold:audit:') && !e.includes(':list')));
  });
test('foreign context, missing baseline or excess batches fail before any dispatch/receipt', async () => {
  for (const mutate of [
    (f) => {
      f.ctx.devices[0] = 'foreign';
    },
    (f) => {
      f.child.remaining.gate = 'FAIL';
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(runCold409Sampling(f.ctx));
    assert.equal(f.events.length, 0);
    assert.equal(f.child.cold409Sampling, undefined);
  }
  for (const batches of [0, 3, 1.5]) {
    const f = fixture();
    await assert.rejects(runCold409Sampling(f.ctx, { batches }), /BUDGET/);
    assert.equal(f.events.length, 0);
  }
});

test('sampling correlation ledger rejects foreign or missing HTTP rows even with a valid business result', async () => {
  const f = fixture();
  const r = await runCold409Sampling(f.ctx);
  f.child.gate = 'PASS';
  f.child.cleanupComplete = true;
  const patch = { records: r.attempts.map((a) => ({ requestId: a.clientRequestId, status: a.observation.status })) };
  const audit = {
    records: Array.from({ length: 18 }, (_, i) => ({ id: 'cold:audit:' + i, requestId: randomUUID(), status: 200 })),
  };
  f.child.checks.push(
    ...audit.records.map((row) => ({ method: 'GET', id: row.id, gatewayRequestId: row.requestId, status: row.status })),
  );
  assert.equal(validateSamplingCorrelationLedger(f.child, patch, audit), r);
  const bad = structuredClone(patch);
  bad.records[0].requestId = 'foreign';
  assert.throws(() => validateSamplingCorrelationLedger(f.child, bad, audit), /LEDGER_BINDING/);
  const duplicatePatch = structuredClone(patch);
  duplicatePatch.records[0] = { ...duplicatePatch.records[1] };
  assert.throws(() => validateSamplingCorrelationLedger(f.child, duplicatePatch, audit), /LEDGER_BINDING/);
  const duplicateAudit = structuredClone(audit);
  duplicateAudit.records[0] = { ...duplicateAudit.records[1] };
  assert.throws(() => validateSamplingCorrelationLedger(f.child, patch, duplicateAudit), /AUDIT_LEDGER_BINDING/);
  audit.records.pop();
  assert.throws(() => validateSamplingCorrelationLedger(f.child, patch, audit), /AUDIT_LEDGER_BINDING/);
});
