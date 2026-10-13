import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256, logRows } from './qa09-minimum-a5-proof.mjs';
import { assertDirectPartialAssociation } from './check-qa09-minimum-a5.mjs';
const [parentPath, output] = process.argv.slice(2),
  exec = promisify(execFile);
if (!parentPath || !output || existsSync(output)) throw Error('FRESH_DIRECT_ASSOCIATION_REQUIRED');
const parent = JSON.parse(readFileSync(parentPath)),
  partial = parent.partialBatch;
if (!parent.finishedAt || partial?.state !== 'TERMINAL' || !partial.object || !/^[a-f0-9-]{36}$/.test(partial.eventId))
  throw Error('TERMINAL_OWN_DIRECT_INVOCATION_REQUIRED');
const events = [];
let token;
for (let i = 0; i < 10; i++) {
  const { stdout } = await exec(
    'aws',
    [
      'logs',
      'filter-log-events',
      '--log-group-name',
      '/aws/lambda/fdp-test-archive',
      '--start-time',
      String(Date.parse(partial.startedAt) - 1000),
      '--filter-pattern',
      '"' + partial.eventId + '"',
      '--limit',
      '100',
      '--no-paginate',
      ...(token ? ['--next-token', token] : []),
      '--profile',
      'esgiot-readonly',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--cli-connect-timeout',
      '5',
      '--cli-read-timeout',
      '30',
    ],
    { timeout: 45000, maxBuffer: 1048576, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
  );
  const page = JSON.parse(stdout);
  events.push(...(page.events ?? []));
  if (!page.nextToken || page.nextToken === token) break;
  token = page.nextToken;
  if (i === 9) throw Error('DIRECT_LOG_PAGE_LIMIT');
}
const rows = logRows(events),
  proof = assertDirectPartialAssociation(partial, rows);
writeFileSync(
  output,
  JSON.stringify(
    {
      scope: 'INDEPENDENT_READ_ONLY_DIRECT_ARCHIVE_ASSOCIATION',
      readOnly: true,
      parentSha256: sha256(readFileSync(parentPath)),
      proof,
      rows,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(proof.gate);
