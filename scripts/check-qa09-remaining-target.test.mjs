import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRemainingScope } from './check-qa09-remaining-target.mjs';
test('remaining scope cannot replace full core, Active acceptance or failed cleanups', () => {
  for (const mode of [undefined, 'FULL_CORE']) assert.throws(() => validateRemainingScope({ coreMode: mode }, {}, {}));
  assert.throws(
    () =>
      validateRemainingScope(
        {
          coreMode: 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE',
          nonActiveOnly: true,
          fullQa09Accepted: false,
          stages: { foundation: 'PASS', remaining: 'PASS' },
          remaining: { gate: 'PASS' },
          licenseLifecycle: { gate: 'PASS' },
        },
        {},
        {},
      ),
    /ACTIVE_PROOF_FORBIDDEN/,
  );
});
