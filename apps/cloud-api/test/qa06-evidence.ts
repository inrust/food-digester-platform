import { appendFileSync } from 'node:fs';
import { assert } from 'vitest';
import { scanSecurityArtifact } from '../../../scripts/security-leak-scan.mjs';
export function evidence(row: Record<string, unknown>) {
  if (process.env.QA06_TRACE) appendFileSync(process.env.QA06_TRACE, JSON.stringify(row) + '\n');
}
export function inspectArtifact(
  channel: 'response' | 'log' | 'audit' | 'snapshot',
  value: unknown,
  known: readonly string[] = [],
) {
  const result = scanSecurityArtifact(value, known);
  assert.equal(result.findings.length, 0, `QA06 sensitive artifact: ${channel}`);
  evidence({ kind: 'artifact', channel, inspectedNodes: result.inspectedNodes, findings: result.findings });
}
export function proof(name: string, facts: Record<string, unknown>) {
  evidence({ kind: 'proof', name, status: 'PASS', ...facts });
}
