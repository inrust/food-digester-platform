import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScope, execute } from './csr-lifecycle-fixture.mjs';
import { main, singleChannelProof, dualChannelProof } from './run-csr-lifecycle-smoke.mjs';
const scope = { serial: 'csrprobe-0123456789abcdef', username: 'csrprobe-0123456789abcdef@example.invalid' };
test('reject unknown or mismatched ownership before any SQL', async () => {
  const client = {
    query() {
      throw Error('SQL_MUST_NOT_RUN');
    },
  };
  for (const s of [{ ...scope, serial: 'production' }, { ...scope, username: 'other@example.invalid' }, {}])
    await assert.rejects(execute(client, 'cleanup', s), /INVALID_OWN_CSR_SCOPE/);
  assert.deepEqual(validateScope(scope), scope);
  await assert.rejects(execute(client, 'seed', scope), /INVALID_ACTION/);
});
test('real smoke needs explicit opt in and fresh output', async () => {
  const old = process.env.FDP_CSR_LIFECYCLE_TEST;
  delete process.env.FDP_CSR_LIFECYCLE_TEST;
  try {
    await assert.rejects(main('/tmp/no-real-csr-test.json'), /EXPLICIT_ENABLE/);
  } finally {
    if (old !== undefined) process.env.FDP_CSR_LIFECYCLE_TEST = old;
  }
});
function state() {
  return {
    certificates: [
      { id: 'old', status: 'ACTIVE', revoked_at: null },
      {
        id: 'new',
        status: 'ACTIVE',
        rotated_from_id: 'old',
        mqtt_verified_at: '2026-10-22T00:00:01Z',
        rest_verified_at: null,
        rotation_confirmed_at: null,
        rotation_deadline_at: '2026-10-23T00:00:00Z',
        package_destroyed: true,
      },
    ],
  };
}
test('MQTT only requires old active and REST unconfirmed', () => {
  const s = state();
  assert.equal(singleChannelProof(s, 'old', 'new', 'mqtt'), true);
  assert.equal(dualChannelProof(s, 'old', 'new'), false);
  s.certificates[0].status = 'REVOKED';
  assert.equal(singleChannelProof(s, 'old', 'new', 'mqtt'), false);
});
test('REST only requires old active and MQTT unconfirmed', () => {
  const s = state();
  s.certificates[1].mqtt_verified_at = null;
  s.certificates[1].rest_verified_at = '2026-10-22T00:00:01Z';
  assert.equal(singleChannelProof(s, 'old', 'new', 'rest'), true);
  assert.equal(dualChannelProof(s, 'old', 'new'), false);
});
test('dual proof rejects missing channel, wrong predecessor, expired confirmation and retained package', () => {
  const s = state();
  Object.assign(s.certificates[0], { status: 'REVOKED', revoked_at: '2026-10-22T00:00:02Z' });
  Object.assign(s.certificates[1], {
    rest_verified_at: '2026-10-22T00:00:02Z',
    rotation_confirmed_at: '2026-10-22T00:00:02Z',
  });
  assert.equal(dualChannelProof(s, 'old', 'new'), true);
  for (const patch of [
    { mqtt_verified_at: null },
    { rest_verified_at: null },
    { rotated_from_id: 'foreign' },
    { rotation_confirmed_at: '2026-10-24T00:00:00Z' },
    { package_destroyed: false },
  ]) {
    const bad = structuredClone(s);
    Object.assign(bad.certificates[1], patch);
    assert.equal(dualChannelProof(bad, 'old', 'new'), false);
  }
});
test('cleanup refuses a device assigned outside this unassigned test scope', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return {
        rows: sql.startsWith('SELECT id,serial_number')
          ? [{ id: 'id', serial_number: scope.serial, customer_id: 'foreign-customer', site_id: null }]
          : [],
      };
    },
  };
  await assert.rejects(execute(client, 'cleanup', scope), /OWN_DEVICE_SCOPE_DRIFT/);
  assert.equal(
    queries.some((sql) => /^(DELETE|INSERT|UPDATE)/.test(sql)),
    false,
  );
  assert.equal(queries.at(-1), 'ROLLBACK');
});
