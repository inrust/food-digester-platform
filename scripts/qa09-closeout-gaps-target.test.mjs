import test from 'node:test';
import assert from 'node:assert/strict';
import { containsActiveContractDevice } from './qa09-closeout-gaps-target.mjs';
test('contract readback requires the actual nested association and matching device snapshot', () => {
  const own = { association: { deviceId: 'own', status: 'ACTIVE' }, device: { deviceId: 'own' } };
  assert.equal(containsActiveContractDevice([own], 'own'), true);
  for (const x of [
    { deviceId: 'own' },
    { ...own, association: { deviceId: 'other', status: 'ACTIVE' } },
    { ...own, device: { deviceId: 'other' } },
    { ...own, association: { deviceId: 'own', status: 'ENDED' } },
  ])
    assert.equal(containsActiveContractDevice([x], 'own'), false);
  assert.equal(containsActiveContractDevice([], 'own'), false);
});
