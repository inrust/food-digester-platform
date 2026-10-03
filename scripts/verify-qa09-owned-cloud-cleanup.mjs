import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
const [parentFile, output] = process.argv.slice(2);
const bytes = readFileSync(parentFile),
  parent = JSON.parse(bytes);
const certificates = parent.cleanup.filter((c) => c.type === 'iot-certificate'),
  thingLedger = parent.cleanup.filter((c) => c.type === 'iot-thing'),
  things =
    thingLedger.length === 0 && parent.devices?.length === 10 ? parent.devices.map((id) => ({ id })) : thingLedger;
if (
  parent.gate !== 'PASS' ||
  !parent.finishedAt ||
  parent.cleanup.some((c) => c.result !== 'PASS') ||
  certificates.length !== 10 ||
  things.length !== 10 ||
  new Set(certificates.map((c) => c.id)).size !== 10 ||
  certificates.some((c) => !/^[a-f0-9]{64}$/.test(c.id))
)
  throw Error('OWN_CLOUD_CLEANUP_LEDGER_REQUIRED');
for (const c of things) assertOwnCloudDevice(c.id, parent.prefix);
const r = {
  task: 'QA-09',
  scope: 'OWN_CLOUD_CLEANUP_READ_ONLY_VERIFICATION',
  prefix: parent.prefix,
  parentReceipt: parentFile,
  parentReceiptSha256: createHash('sha256').update(bytes).digest('hex'),
  sourceSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  startedAt: new Date().toISOString(),
  checks: [],
  gate: 'RUNNING',
  credentialsExported: false,
  thingInventorySource: thingLedger.length ? 'DELETE_LEDGER' : 'OWN_PARENT_DEVICE_INVENTORY',
  deleteThingLedgerClaimed: thingLedger.length === 10,
};
const execute = promisify(execFile);
const aws = (args) =>
  execute(
    'aws',
    [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
if (JSON.parse((await aws(['sts', 'get-caller-identity'])).stdout).Account !== '065986019555')
  throw Error('WRONG_ACCOUNT');
const jobs = [
  ...certificates.map((c) => ({
    type: 'certificate',
    id: c.id,
    args: ['iot', 'describe-certificate', '--certificate-id', c.id],
  })),
  ...things.map((c) => ({ type: 'thing', id: c.id, args: ['iot', 'describe-thing', '--thing-name', c.id] })),
];
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const item = jobs[next++];
      let absent = false,
        errorCode;
      try {
        await aws(item.args);
      } catch (e) {
        errorCode = e.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED';
        absent = errorCode === 'ResourceNotFoundException';
      }
      r.checks.push({ type: item.type, id: item.id, result: absent ? 'PASS' : 'FAIL', errorCode });
    }
  }),
);
r.finishedAt = new Date().toISOString();
r.gate = r.checks.length === 20 && r.checks.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL';
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ gate: r.gate, checks: r.checks.length }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
