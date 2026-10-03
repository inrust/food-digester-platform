import { readFileSync } from 'node:fs';
import { redeliverOwnArchive } from './qa09-archive-redelivery-reader.mjs';
const [parent, output] = process.argv.slice(2);
const r = JSON.parse(readFileSync(parent)),
  a = JSON.parse(readFileSync(parent + '.archive-read.json')),
  o = JSON.parse(readFileSync(parent + '.observe-2.json')).result;
if (r.gate !== 'RUNNING' || a.gate !== 'PASS' || r.prefix !== a.prefix || o.prefix !== r.prefix)
  throw Error('OWN_RUNNING_FIXTURE_REQUIRED');
const cert = o.certificates.find((c) => c.device_id === r.devices[2] && c.status === 'ACTIVE');
if (!cert || !/^[a-f0-9]{64}$/.test(cert.id)) throw Error('OWN_ACTIVE_CERT_REQUIRED');
await redeliverOwnArchive(
  { ...r, published: a.plan.published },
  o,
  output,
  a.result.archiveObjects.map((x) => x.key),
  cert.id,
);
