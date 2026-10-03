import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
import { runBusinessTarget } from './qa09-business-target.mjs';
const [output, version, origin = 'https://admin.bio-nexa.com'] = process.argv.slice(2);
if (!output || !version || origin !== 'https://admin.bio-nexa.com') throw Error('APPROVED_TARGET_AND_OUTPUT_REQUIRED');
const paths = [
  'scripts/run-qa09-business-target.mjs',
  'scripts/qa09-business-target.mjs',
  'scripts/qa09-license-lifecycle.mjs',
  'scripts/qa09-publish-scheduler.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/qa09-mqtt-load-target.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-current-environment.mjs',
  'infra/environments/qa09-current-test.json',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      task: 'QA-09',
      scope: 'EXECUTED_SOURCE_BYTES',
      sources: paths.map((path) => {
        const b = readFileSync(path);
        return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
const parent = await main(output + '.devices.json', version, async (ctx) => {
  await runBusinessTarget(ctx, output, { browserOrigin: origin });
});

let domain;
if (parent.gate === 'PASS' && parent.cleanup.every((c) => c.result === 'PASS')) {
  domain = await cleanupOwnedDomain(output + '.devices.json', output + '.domain-cleanup.json');
}
const child = JSON.parse(readFileSync(output));
process.exitCode = parent.gate === 'PASS' && child.gate === 'PASS' && domain?.gate === 'PASS' ? 0 : 1;
