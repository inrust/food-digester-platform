import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkMinimumPhaseContext } from './collect-qa09-minimum-phase.mjs';
export async function runMinimumPhaseCheck(input, output) {
  if (!input || (output && existsSync(output))) throw Error('INPUT_AND_FRESH_OUTPUT_REQUIRED');
  const result = await checkMinimumPhaseContext(JSON.parse(readFileSync(input)));
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runMinimumPhaseCheck(...process.argv.slice(2));
