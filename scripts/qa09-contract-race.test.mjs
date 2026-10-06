import test from 'node:test';
import assert from 'node:assert/strict';
import { runContractRaceTarget } from './qa09-contract-race.mjs';
const prefix = 'qa09-1234567890abcdef';
function fixture(fault) {
  const events = [];
  let version = 1,
    name = prefix + '-race';
  const audit = [];
  const ctx = {
    prefix,
    devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    customers: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].map((id, i) => ({
      id,
      name: prefix + (i ? '-b' : '-a'),
    })),
    businessReceipt: { checks: [] },
    save() {},
    async waitForWriteQuiescence() {
      events.push('write-grace');
    },
    async api(id, role, method, path, expected, body, headers) {
      events.push(id + ':start');
      if (fault === 'transport' && id === 'race:1:a') {
        ctx.businessReceipt.checks.push({ id, responseReceived: false });
        throw Error('UNKNOWN_WRITE_OUTCOME');
      }
      let status = 200,
        errorCode = null;
      if (method === 'PATCH') {
        const round = Number(id.split(':')[1]);
        const winner = round % 2 ? 'b' : 'a';
        await new Promise((r) => setTimeout(r, id.endsWith(winner) ? 1 : 4));
        if (Number(headers['If-Match']) === version || fault === 'double-winner') {
          version++;
          name = body.name;
          audit.push({
            auditId: 'audit-' + audit.length,
            objectType: 'contract',
            objectId: 'own-contract',
            result: 'SUCCESS',
            beforeValue: { version: version - 1 },
            afterValue: { version },
            requestId: fault === 'audit-id' ? 'foreign' : headers['x-amzn-RequestId'],
          });
        } else {
          status = 409;
          errorCode = 'VERSION_CONFLICT';
        }
        ctx.businessReceipt.checks.push({
          id,
          status,
          errorCode,
          gatewayRequestId: fault === 'gateway-id' ? 'foreign' : headers['x-amzn-RequestId'],
        });
      }
      events.push(id + ':done');
      if (path.includes('audit-logs?')) return { data: audit, meta: { nextCursor: null } };
      if (path.includes('audit-logs/')) return { data: audit.find((x) => path.endsWith(x.auditId)) };
      return { data: { contractId: 'own-contract', customerId: ctx.customers[0].id, name, version, status: 'DRAFT' } };
    },
  };
  return { ctx, events };
}
test('three races accept either winner, bind every successful write to audit and advance once per version', async () => {
  const { ctx, events } = fixture();
  const r = await runContractRaceTarget(ctx);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.rounds.length, 3);
  assert.equal(r.finalContract.version, 4);
  assert.equal(new Set(r.attempts.map((x) => x.clientRequestId)).size, 6);
  assert.equal(r.audit.length, 3);
  assert.ok(events.indexOf('race:1:a:start') < events.indexOf('race:1:b:done'));
});
test('early failure still drains the late sibling before readback and never retries or reports PASS', async () => {
  const { ctx, events } = fixture('transport');
  const r = await runContractRaceTarget(ctx);
  assert.equal(r.gate, 'FAIL');
  assert.deepEqual(r.rounds[0].settled, ['rejected', 'fulfilled']);
  assert.ok(events.indexOf('race:1:b:done') < events.indexOf('race:1:after:start'));
  assert.equal(r.attempts.length, 2);
  assert.ok(events.indexOf('race:1:b:done') < events.indexOf('write-grace'));
  assert.ok(events.indexOf('write-grace') < events.indexOf('race:1:after:start'));
  assert.equal(r.attempts[0].state, 'REJECTED');
  assert.ok(r.attempts.every((x) => x.completedAt));
});
for (const fault of ['double-winner', 'gateway-id', 'audit-id'])
  test('race fails closed for ' + fault, async () => {
    const { ctx } = fixture(fault);
    assert.equal((await runContractRaceTarget(ctx)).gate, 'FAIL');
  });
test('foreign context fails before dispatch or receipt writes', async () => {
  const { ctx, events } = fixture();
  ctx.devices[0] = 'foreign';
  await assert.rejects(runContractRaceTarget(ctx), /OWN_BUSINESS_CONTEXT_REQUIRED/);
  assert.equal(events.length, 0);
  assert.equal(ctx.businessReceipt.remaining, undefined);
});
test('historical read scope rejects any resource outside the exact sealed old contract before live calls', async () => {
  const { ctx, events } = fixture();
  const r = await runContractRaceTarget(ctx, {
    historical: { prefix: 'qa09-0ed30921f63c8541', contractId: 'foreign' },
  });
  assert.equal(r.gate, 'FAIL');
  assert.equal(r.failureCode, 'HISTORICAL_CONTRACT_SCOPE_FORBIDDEN');
  assert.equal(events.length, 0);
});
