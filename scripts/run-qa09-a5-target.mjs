import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runReliabilityCloseout } from './run-qa09-reliability-closeout-target.mjs';
export const runA5Target = (output, version) => runReliabilityCloseout(output, version, { a5: true });
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, version] = process.argv.slice(2);
  if (!output || !version) throw Error('FRESH_OUTPUT_AND_VERIFIED_VERSION_REQUIRED');
  const result = await runA5Target(output, version);
  process.exitCode = result.gate === 'PASS' && result.reliabilityGate === 'PASS_SCOPED_RELIABILITY' ? 0 : 1;
}
