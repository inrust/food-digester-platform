/** P0 reference model. Models atomic conditional transactions, not an AWS adapter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type State = {
  revision: number;
  epoch: number;
  customer: string;
  enabled: boolean;
  stream: number;
  leases: Record<string, number>;
  latest: number;
  lastNew: number;
  dedup: Record<string, { hash: string; until: number }>;
  frame: { id: string; captured: number; expires: number; stream: number } | null;
};
const initial = (): State => ({
  revision: 0,
  epoch: 1,
  customer: 'A',
  enabled: true,
  stream: 1,
  leases: { alice: 30 },
  latest: -1,
  lastNew: -100,
  dedup: {},
  frame: null,
});
const copy = (state: State): State => structuredClone(state);
const active = (state: State, now: number) => Object.values(state.leases).some((end) => end > now);
const visible = (state: State, now: number) =>
  state.enabled &&
  active(state, now) &&
  state.frame !== null &&
  state.frame.stream === state.stream &&
  state.frame.expires > now;

function commit(state: State, observed: State, mutation: (next: State) => void): boolean {
  if (state.revision !== observed.revision || state.epoch !== observed.epoch || state.customer !== observed.customer)
    return false;
  const next = copy(observed);
  mutation(next);
  next.revision++;
  Object.assign(state, next);
  return true;
}
function upload(state: State, observed: State, id: string, captured: number, now: number, hash = id): boolean {
  if (state.revision !== observed.revision || state.epoch !== observed.epoch) return false;
  if (!observed.enabled || !active(observed, now)) return false;
  const duplicate = observed.dedup[id];
  if (duplicate && duplicate.until > now) return duplicate.hash === hash;
  if (now - observed.lastNew < 1) return false;
  if (!observed.enabled || !active(observed, now) || captured <= observed.latest || captured + 10 <= now) return false;
  return commit(state, observed, (next) => {
    next.latest = captured;
    next.lastNew = now;
    next.dedup[id] = { hash, until: now + 15 };
    next.frame = { id, captured, expires: Math.min(captured + 10, now + 10), stream: next.stream };
  });
}
function release(state: State, observed: State, owner: string): boolean {
  return commit(state, observed, (next) => {
    delete next.leases[owner];
  });
}
function revoke(state: State, customer: string): void {
  state.epoch++;
  state.revision++;
  state.customer = customer;
  state.enabled = false;
  state.leases = {};
  state.frame = null;
  state.latest = -1;
  state.stream++;
}

// All six legal interleavings of two read/conditional-commit operations.
const schedules = [
  ['UR', 'UC', 'RR', 'RC'],
  ['UR', 'RR', 'UC', 'RC'],
  ['UR', 'RR', 'RC', 'UC'],
  ['RR', 'RC', 'UR', 'UC'],
  ['RR', 'UR', 'RC', 'UC'],
  ['RR', 'UR', 'UC', 'RC'],
];
test('last lease release racing frame upload, all six read/commit schedules', () => {
  for (const schedule of schedules) {
    const state = initial();
    let u = copy(state);
    let r = copy(state);
    let released = false;
    for (const op of schedule) {
      if (op === 'UR') u = copy(state);
      if (op === 'RR') r = copy(state);
      if (op === 'UC') upload(state, u, 'frame', 1, 1);
      if (op === 'RC') {
        // Adapter must retry stale revision with a fresh snapshot.
        released = release(state, r, 'alice') || release(state, copy(state), 'alice');
      }
      if (released) assert.equal(visible(state, 1), false, schedule.join());
    }
    assert.equal(active(state, 1), false);
  }
});
test('multiple viewers share a stream; stale renewal retries cannot lose another lease', () => {
  const state = initial();
  const observed = copy(state);
  assert.ok(
    commit(state, observed, (next) => {
      next.leases.bob = 35;
    }),
  );
  assert.equal(release(state, observed, 'alice'), false);
  assert.ok(release(state, copy(state), 'alice'));
  assert.ok(active(state, 2));
  assert.equal(state.stream, 1);
  assert.ok(upload(state, copy(state), 'bob-frame', 2, 2));
  assert.ok(visible(state, 2));
  assert.equal(visible(state, 35), false); // TTL deletion has not run.
});
test('older frame cannot overwrite newer frame, even with a late commit', () => {
  const state = initial();
  const old = copy(state);
  assert.ok(upload(state, copy(state), 'new', 5, 5));
  assert.equal(upload(state, old, 'old', 2, 6), false);
  assert.equal(upload(state, copy(state), 'old', 2, 6), false);
  assert.equal(state.frame?.id, 'new');
});
for (const customer of ['A', 'B']) {
  test(`authorization fence blocks an in-flight frame on revoke/tenant change to ${customer}`, () => {
    const state = initial();
    const observed = copy(state);
    revoke(state, customer);
    assert.equal(upload(state, observed, 'late', 3, 3), false);
    assert.equal(visible(state, 3), false);
    state.enabled = true;
    state.leases = { bob: 40 };
    assert.equal(upload(state, observed, 'old-stream', 4, 4), false);
    assert.equal(state.stream, 2);
  });
}
test('expiry uses capture time as well as receipt time', () => {
  const state = initial();
  assert.ok(upload(state, copy(state), 'delayed', 1, 9));
  assert.equal(state.frame?.expires, 11);
  assert.equal(visible(state, 11), false);
});

test('dedup replay does not renew freshness; conflict and per-device rate enforced', () => {
  const state = initial();
  assert.ok(upload(state, copy(state), 'one', 1, 1));
  const revision = state.revision;
  assert.ok(upload(state, copy(state), 'one', 1, 2));
  assert.equal(state.revision, revision);
  assert.equal(state.frame?.expires, 11);
  assert.equal(upload(state, copy(state), 'one', 1, 2, 'changed'), false);
  assert.equal(upload(state, copy(state), 'two', 1.5, 1.5), false);
  assert.ok(upload(state, copy(state), 'two', 2, 2));
});

test('revocation also fences duplicate replay observed before revocation', () => {
  const state = initial();
  assert.ok(upload(state, copy(state), 'one', 1, 1));
  const stale = copy(state);
  revoke(state, 'B');
  assert.equal(upload(state, stale, 'one', 1, 2), false);
});
