import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRedeliveryScope } from './qa09-archive-redelivery-reader.mjs';
test('redelivery rejects foreign archives, unbounded inventories and unbound certificates before AWS operations', () => {
  const proof = JSON.parse(
    readFileSync('docs/audit/evidence/qa-09-slo-target-2026-10-03.json.devices.json.archive-read.json'),
  );
  const plan = {
    ...proof.plan,
    archivedKeys: proof.result.archiveObjects.map((x) => x.key),
    certificateId: 'a'.repeat(64),
  };
  assert.doesNotThrow(() => validateRedeliveryScope(plan));
  for (const patch of [
    { archivedKeys: ['raw/topic_type=telemetry/customer_id=foreign/file.json.gz'] },
    { archivedKeys: ['raw/topic_type=ack/customer_id=' + plan.customers[0] + '/file.json.gz'] },
    { archivedKeys: Array(201).fill(plan.archivedKeys[0]) },
    { certificateId: 'another-cert' },
    { archivedKeys: [] },
  ])
    assert.throws(() => validateRedeliveryScope({ ...plan, ...patch }));
});
