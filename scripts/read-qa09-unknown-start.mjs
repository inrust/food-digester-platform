import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fixtureAws } from './qa09-ten-device-bridge.mjs';
import { PROJECT } from './qa09-ten-device-db.mjs';
import { STARTED_BUILD_QUERY } from './qa09-started-build-read.mjs';
import { readUnknownStart, validateUnknownStart } from './qa09-unknown-start-read.mjs';
import { safeOperationError } from './qa09-operation-observation.mjs';

export async function collectUnknownStart(originalFile, output, { aws = fixtureAws } = {}) {
  if (!originalFile || !output || existsSync(output)) throw Error('NEW_UNKNOWN_START_OUTPUT_REQUIRED');
  const raw = readFileSync(originalFile),
    preparation = readFileSync(originalFile + '.preparation.json');
  const original = JSON.parse(raw),
    prep = JSON.parse(preparation),
    observations = [];
  validateUnknownStart(original, prep);
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  const result = {
    gate: 'RUNNING',
    scope: 'READ_ONLY_UNKNOWN_START_IDENTITY_NO_REPLAY',
    originalReceiptSha256: hash(raw),
    preparationSha256: hash(preparation),
    executorSha256: hash(readFileSync(new URL(import.meta.url))),
    readerSha256: hash(readFileSync(new URL('./qa09-unknown-start-read.mjs', import.meta.url))),
    originalGate: 'FAIL',
    originalStartGate: 'UNKNOWN',
    writes: 0,
    restartAllowed: false,
    observations,
  };
  const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const read = (args, limits) => aws(args, 'esgiot-readonly', limits);
  save();
  try {
    Object.assign(
      result,
      await readUnknownStart(
        original,
        prep,
        {
          identity: (limits) => read(['sts', 'get-caller-identity'], limits),
          list: (limits) =>
            read(
              [
                'codebuild',
                'list-builds-for-project',
                '--project-name',
                PROJECT,
                '--sort-order',
                'DESCENDING',
                '--max-items',
                '50',
              ],
              limits,
            ),
          builds: (ids, limits) =>
            read(
              [
                'codebuild',
                'batch-get-builds',
                '--ids',
                ...ids,
                '--query',
                STARTED_BUILD_QUERY.replace('builds[0].', 'builds[].'),
              ],
              limits,
            ),
        },
        { observations, onObservation: save },
      ),
    );
  } catch (error) {
    Object.assign(result, {
      gate: 'UNAVAILABLE',
      failure: safeOperationError(error),
      absenceProvesNonExecution: false,
    });
  }
  result.finishedAt = new Date().toISOString();
  save();
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await collectUnknownStart(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ gate: result.gate, buildId: result.buildId, writes: 0, restartAllowed: false }));
  if (result.gate !== 'RESOLVED') process.exitCode = 1;
}
