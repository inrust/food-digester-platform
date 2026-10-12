// Read-only narrower recovery after the original fifty-build detail read timed out.
import { collectUnknownStart } from '../../../../scripts/read-qa09-unknown-start.mjs';
import { fixtureAws } from '../../../../scripts/qa09-ten-device-bridge.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const prior = new URL('r0/business-audit-unknown-resolution.json', root);
const original = new URL('r0/sample.json.business-audit-2.json', root);
const output = new URL('r0/business-audit-unknown-recent-five.json', root);
const binding = new URL('r0/business-audit-unknown-recent-five-binding.json', root);
const hash = (u) => createHash('sha256').update(readFileSync(u)).digest('hex');
if (JSON.parse(readFileSync(prior)).gate !== 'UNAVAILABLE' || existsSync(output) || existsSync(binding))
  throw Error('ORIGINAL_UNAVAILABLE_AND_FRESH_OUTPUT_REQUIRED');
const originalHash = hash(original), priorHash = hash(prior);
writeFileSync(binding, JSON.stringify({
  scope: 'READ_ONLY_RECENT_FIVE_AFTER_ORIGINAL_FIFTY_DETAIL_TIMEOUT',
  originalSha256: originalHash, priorReadSha256: priorHash,
  wrapperSha256: hash(new URL(import.meta.url)),
  maxInventory: 5, detailBatch: 5, cliTimeoutMs: 15000, totalReadBudgetMs: 90000,
  startBuildCalls: 0, writes: 0, originalGatePreserved: 'FAIL',
}, null, 2) + '\n');
const result = await collectUnknownStart(fileURLToPath(original), fileURLToPath(output), {
  aws(args, profile, limits) {
    const bounded = [...args];
    if (bounded[1] === 'list-builds-for-project') bounded[bounded.indexOf('--max-items') + 1] = '5';
    if (bounded[1] === 'batch-get-builds') {
      const first = bounded.indexOf('--ids') + 1, end = bounded.indexOf('--query');
      if (end - first > 5) throw Error('RECENT_FIVE_DETAIL_BATCH_EXCEEDED');
    }
    return fixtureAws(bounded, profile, { ...limits, timeoutMs: Math.min(15000, limits.timeoutMs) });
  },
});
if (hash(original) !== originalHash || hash(prior) !== priorHash) throw Error('ORIGINAL_BYTES_CHANGED');
console.log(JSON.stringify({ gate: result.gate, reason: result.reason, buildId: result.buildId, windowCovered: result.windowCovered, writes: 0, restartAllowed: false }));
if (result.gate !== 'RESOLVED') process.exitCode = 1;
