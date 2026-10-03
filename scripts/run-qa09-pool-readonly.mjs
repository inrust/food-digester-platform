import { readFileSync } from 'node:fs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
const [output] = process.argv.slice(2);
if (!output) throw Error('OUTPUT_REQUIRED');
const { plan } = JSON.parse(
  readFileSync('docs/audit/evidence/qa-09-performance-capacity-readonly-2026-10-03.json.preparation.json'),
);
await runFixture({ ...plan, action: 'capacity-pool-readonly' }, output, console.log);
