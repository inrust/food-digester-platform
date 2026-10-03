import test from 'node:test';
import assert from 'node:assert/strict';
import { executePoolReadOnly } from './qa09-ten-device-db.mjs';
function pool(ownConnections = 1) {
  let tail = Promise.resolve();
  const query = async (sql) => {
    if (sql.includes('current_setting'))
      return {
        rows: [
          {
            max_connections: 79,
            superuser_reserved_connections: 3,
            reserved_connections: 2,
            rds_reserved_connections: 4,
          },
        ],
      };
    if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 1, own_connections: ownConnections }] };
    if (sql === 'SELECT 1/0') throw Object.assign(Error('synthetic'), { code: '22012' });
    return { rows: [] };
  };
  const connect = async () => {
    let release;
    const old = tail;
    tail = new Promise((r) => {
      release = r;
    });
    await old;
    return { query, release };
  };
  return {
    totalCount: 1,
    waitingCount: 0,
    connect,
    query: async (sql, args) => {
      const c = await connect();
      try {
        return await c.query(sql, args);
      } finally {
        c.release();
      }
    },
  };
}
test('read-only pool probe distinguishes one connection, recovery and incomplete capacity acceptance', async () => {
  const r = await executePoolReadOnly(pool(), 'qa09-pool-0123456789abcdef');
  assert.equal(r.gate, 'PASS');
  assert.equal(r.ordinarySlots, 70);
  assert.equal(r.parallelTasks, 24);
  assert.equal(r.expectedReadErrorsRolledBack, 1);
  assert.equal(r.databaseWrites, 0);
  assert.match(r.scope, /NOT_PRISMA_OR_HTTP/);
});
test('observed connection-budget violation refuses a pool PASS receipt', async () => {
  await assert.rejects(executePoolReadOnly(pool(2), 'qa09-pool-0123456789abcdef'), /POOL_ONE_BOUNDARY_NOT_PROVED/);
});
test('foreign probe application name is rejected before database access', async () => {
  let queried = false;
  await assert.rejects(
    executePoolReadOnly(
      {
        query: () => {
          queried = true;
        },
      },
      'shared-application',
    ),
    /INVALID_POOL_PROBE_SCOPE/,
  );
  assert.equal(queried, false);
});
