import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export function validateCaRootRepair(r) {
  const result = r.repair;
  if (
    r.scope !== 'AWS_ONLY_CA_ROOT_REPAIR_AND_TEN_DEVICE' ||
    r.account !== '065986019555' ||
    r.region !== 'ap-southeast-1' ||
    !r.finishedAt ||
    r.secretValuesExported !== false ||
    r.privateKeysExported !== false ||
    r.fullQa09Accepted !== false
  )
    throw Error('REPAIR_EXECUTION_NOT_VERIFIED');
  if (
    result?.completed !== true ||
    result.schema !== 'fdp-qa09-ca-root-repair/v1' ||
    result.requestNonce !== r.requestNonce ||
    result.candidateVersion !== r.candidateToken ||
    result.baselineVersion !== 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9' ||
    result.promoted !== true ||
    result.rolledBack !== false ||
    result.originalVersionRetained !== true ||
    result.otherFieldsUnchanged !== true ||
    result.secretValuesExported !== false
  )
    throw Error('SECRET_REPAIR_NOT_VERIFIED');
  if (
    !r.afterVersionStages?.[result.candidateVersion]?.includes('AWSCURRENT') ||
    !r.afterVersionStages?.[result.baselineVersion]?.includes('AWSPREVIOUS') ||
    r.workerRefreshed?.bindingUnchanged !== true ||
    r.invocation?.ExecutedVersion !== '1' ||
    r.invocation?.FunctionError
  )
    throw Error('STAGE_OR_WORKER_NOT_VERIFIED');
  for (const type of [
    'worker-description-restored',
    'temporary-function-deleted',
    r.noTemporaryPermissions === true ? 'no-temporary-worker-policy-needed' : 'temporary-worker-policy-revoked',
    r.mode === 'VERIFY_EXISTING_VERSION_READ_ONLY'
      ? 'boundary-v3-preserved-no-write-grant'
      : 'boundary-restored-v3-temporary-version-deleted',
    'original-worker-policy-and-boundary-preserved',
  ])
    if (r.cleanup?.filter((c) => c.type === type && c.result === 'PASS').length !== 1)
      throw Error('REPAIR_CLEANUP_NOT_VERIFIED');
  for (const path of [
    'scripts/qa09-ca-root-repair-handler.mjs',
    'scripts/qa09-ca-root-repair.mjs',
    'scripts/qa09-ca-chain-diagnostic.mjs',
  ]) {
    const s = r.sources?.find((s) => s.path === path);
    if (!s || createHash('sha256').update(Buffer.from(s.sourceBase64, 'base64')).digest('hex') !== s.sha256)
      throw Error('REPAIR_SOURCE_NOT_VERIFIED');
  }
  return {
    task: 'QA-09',
    scope: 'CA_ROOT_FIELD_REPAIR',
    gate: 'PASS',
    baselineVersion: result.baselineVersion,
    newVersion: result.candidateVersion,
    otherFieldsUnchanged: true,
    originalVersionRetained: true,
    cleanup: 'PASS',
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try {
    result = validateCaRootRepair(JSON.parse(readFileSync(process.argv[2])));
  } catch (error) {
    result = {
      task: 'QA-09',
      scope: 'CA_ROOT_FIELD_REPAIR',
      gate: 'FAIL',
      reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'REPAIR_GATE_FAILED',
      fullQa09Accepted: false,
    };
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = result.gate === 'PASS' ? 0 : 1;
}
