/** Explicit target provenance for the existing test environment. No cloud operations. */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CURRENT_TEST_CONFIG } from './qa09-current-environment.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const CONTEXT_DOCUMENT_FILES = [
  'docs/dev/QA-09-A1正式验收入口与冻结清单.md',
  'docs/audit/QA-09-A1正式入口与证据冻结实施记录-2026-10-13.md',
  'docs/dev/QA-09-业务闭环优先收口计划.md',
  'docs/管理后台开发任务清单.md',
];
export const CONTEXT_EXECUTOR_FILES = [
  'scripts/qa09-acceptance-context.mjs',
  'scripts/qa09-acceptance-scope.mjs',
  'scripts/collect-qa09-acceptance-inventory.mjs',
  'scripts/check-qa09-acceptance.mjs',
  'scripts/qa09-current-environment.mjs',
  'scripts/collect-qa09-business-reconciliation.mjs',
  'scripts/qa09-formal-closeout-map.mjs',
  'scripts/qa09-business-reconciliation.mjs',
  'scripts/qa09-user-closeout-browser.mjs',
  ...[
    'aws-iot-data-path',
    'aws-data-processing',
    'aws-admin-cus-dev',
    'aws-admin-business',
    'aws-med-rbac-aud-dash-set',
    'admin-web-target',
    'admin-web-fe11-15-target',
    'admin-web-fe16-19-target',
  ].map((name) => `scripts/check-${name}-evidence.mjs`),
  'contracts/evidence/fe-11-15-admin-web-target.schema.json',
  'contracts/evidence/fe-16-19-admin-web-target.schema.json',
  'contracts/prototype-traceability.yaml',
  'infra/environments/qa09-current-test.json',
];

export function readBoundFile(root, ref) {
  if (
    !ref ||
    typeof ref.path !== 'string' ||
    isAbsolute(ref.path) ||
    ref.path.split('/').includes('..') ||
    !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')
  )
    throw Error('INVALID_FILE_BINDING');
  const path = realpathSync(resolve(root, ref.path));
  if (relative(realpathSync(root), path).startsWith('..')) throw Error('BINDING_OUTSIDE_REPOSITORY');
  const bytes = readFileSync(path);
  if (sha256(bytes) !== ref.sha256) throw Error('FILE_BINDING_DRIFT:' + ref.path);
  return bytes;
}
export function bindFile(root, path) {
  const sha = sha256(readFileSync(resolve(root, path)));
  readBoundFile(root, { path, sha256: sha });
  return { path, sha256: sha };
}
export function contentSnapshot(root, baseCommit, paths) {
  const files = [...new Set(paths)].sort().map((path) => bindFile(root, path));
  return { kind: 'CONTENT_SNAPSHOT', baseCommit, files, snapshotSha256: sha256(JSON.stringify(files)) };
}
function verifySnapshot(root, snapshot, required, prefix) {
  if (
    snapshot?.kind !== 'CONTENT_SNAPSHOT' ||
    !/^[a-f0-9]{40}$/.test(snapshot.baseCommit ?? '') ||
    !Array.isArray(snapshot.files)
  )
    throw Error('INVALID_CONTENT_VERSION');
  execFileSync('git', ['cat-file', '-e', snapshot.baseCommit + '^{commit}'], { cwd: root, stdio: 'pipe' });
  const paths = snapshot.files.map((ref) => ref.path);
  if (
    new Set(paths).size !== paths.length ||
    required.some((path) => !paths.includes(path)) ||
    paths.some((path) => !prefix.some((p) => path.startsWith(p)))
  )
    throw Error('INCOMPLETE_CONTENT_VERSION');
  if (sha256(JSON.stringify(snapshot.files)) !== snapshot.snapshotSha256) throw Error('CONTENT_VERSION_DIGEST_DRIFT');
  snapshot.files.forEach((ref) => readBoundFile(root, ref));
}
export function targetEnvironmentErrors(environment, context) {
  if (environment?.isolated === true && !context) return [];
  if (!context || environment?.isolated !== false || environment.mode !== CURRENT_TEST_CONFIG.mode)
    return ['environment.isolated 必须为 true，或提供显式现有测试环境绑定'];
  const errors = [];
  for (const key of ['accountId', 'region', 'stackName']) {
    if (environment[key] !== CURRENT_TEST_CONFIG[key] || context.environment?.[key] !== CURRENT_TEST_CONFIG[key])
      errors.push('environment.' + key + ' 与现有测试环境不一致');
  }
  if (
    context.environment?.mode !== CURRENT_TEST_CONFIG.mode ||
    context.environment?.isolated !== false ||
    context.environment?.syntheticResponsesAllowed !== false ||
    context.environment?.dataSeparation !== CURRENT_TEST_CONFIG.dataSeparation
  )
    errors.push('INVALID_EXISTING_TEST_ENVIRONMENT_CONTEXT');
  if (!/^qa09-[a-f0-9]{16}$/.test(environment.runPrefix ?? ''))
    errors.push('environment.runPrefix 必须绑定自有创建ID账本');
  return errors;
}
export function validateTargetBindings(root, context) {
  if (
    context?.schemaVersion !== '2.0' ||
    context.task !== 'QA09-A1' ||
    context.scope !== 'QA09_BUSINESS_ACCEPTANCE_ENTRY' ||
    context.fullQa09Accepted !== false ||
    context.productionReady !== false
  )
    throw Error('INVALID_ACCEPTANCE_CONTEXT');
  if (targetEnvironmentErrors({ ...context.environment, runPrefix: 'qa09-0000000000000000' }, context).length)
    throw Error('WRONG_BOUND_ENVIRONMENT');
  const application = context.versions?.application;
  if (
    !/^[a-f0-9]{40}$/.test(application?.sourceCommit ?? '') ||
    !/^[a-f0-9]{40}$/.test(application?.deploymentCommit ?? '')
  )
    throw Error('EXACT_APPLICATION_VERSION_REQUIRED');
  const version = JSON.parse(readBoundFile(root, application.versionReceipt));
  const commit = application.sourceCommit;
  execFileSync('git', ['cat-file', '-e', commit + '^{commit}'], { cwd: root, stdio: 'pipe' });
  if (
    version.sourceCommit !== commit ||
    version.gate !== 'PASS' ||
    version.github?.headSha !== application.deploymentCommit ||
    version.github?.conclusion !== 'success' ||
    version.github?.status !== 'completed' ||
    version.ci?.headSha !== commit ||
    version.ci?.conclusion !== 'success' ||
    version.ci?.status !== 'completed' ||
    version.amplify?.[0]?.commitId !== commit ||
    version.amplify?.[0]?.status !== 'SUCCEED' ||
    version.lambdaArtifacts?.length !== 19 ||
    new Set(version.lambdaArtifacts.map((row) => row.name)).size !== 19 ||
    version.lambdaArtifacts.some(
      (row) =>
        row.matches !== true ||
        row.codeSha256 !== row.artifactSha256 ||
        !/^[A-Za-z0-9+/]{43}=$/.test(row.codeSha256 ?? ''),
    )
  )
    throw Error('APPLICATION_DEPLOYMENT_NOT_BOUND');
  for (const key of ['accountId', 'region', 'stackName'])
    if (version[key] !== context.environment[key]) throw Error('APPLICATION_ENVIRONMENT_DRIFT');
  const config = JSON.parse(readBoundFile(root, application.configurationReceipt));
  if (
    config.gate !== 'PASS' ||
    config.sourceCommit !== commit ||
    config.config?.envName !== 'test' ||
    config.config?.state !== 'Active' ||
    config.config?.update !== 'Successful' ||
    config.config?.pool !== '1' ||
    config.config?.memory !== 512 ||
    config.concurrency?.ReservedConcurrentExecutions !== 12 ||
    [
      'preconnect',
      'accountReadCandidate',
      'contractLoadDetail',
      'contractPublicBoundaries',
      'contractObserverCost',
    ].some((key) => config.config[key] !== 'false')
  )
    throw Error('APPLICATION_CONFIGURATION_NOT_BOUND');
  verifySnapshot(root, context.versions.executor, CONTEXT_EXECUTOR_FILES, [
    'scripts/',
    'contracts/',
    'infra/environments/',
  ]);
  if (JSON.stringify(context.requiredDocumentation) !== JSON.stringify(CONTEXT_DOCUMENT_FILES))
    throw Error('DOCUMENT_VERSION_REQUIRED');
  verifySnapshot(root, context.versions.documentation, CONTEXT_DOCUMENT_FILES, ['docs/']);
  readBoundFile(root, context.frozenScope);
  readBoundFile(root, context.inventory);
  if (
    !Array.isArray(context.formalReceipts) ||
    new Set(context.formalReceipts.map((row) => row.validator)).size !== context.formalReceipts.length
  )
    throw Error('INVALID_FORMAL_RECEIPT_SET');
  return context;
}
export function validateReceiptBinding(root, path, receipt, context, validator) {
  if (!context) return [];
  try {
    validateTargetBindings(root, context);
    const row = context.formalReceipts.find((entry) => entry.validator === validator);
    if (!row || resolve(root, row.receipt.path) !== resolve(root, path)) throw Error('FORMAL_RECEIPT_NOT_BOUND');
    readBoundFile(root, row.receipt);
    const ledger = JSON.parse(readBoundFile(root, row.createdIdLedger));
    const cleanup = JSON.parse(readBoundFile(root, row.cleanupReceipt));
    const deviceIds = ledger.devices ?? [];
    const customers = ledger.customers ?? [];
    if (
      receipt.sourceCommit !== context.versions.application.sourceCommit ||
      ledger.sourceCommit !== receipt.sourceCommit ||
      cleanup.sourceCommit !== receipt.sourceCommit ||
      !ledger.finishedAt ||
      ledger.gate !== 'PASS' ||
      ledger.cleanupHold ||
      deviceIds.length + customers.length === 0 ||
      new Set(deviceIds).size !== deviceIds.length ||
      deviceIds.some((id) => typeof id !== 'string' || !id.startsWith(ledger.prefix + '-')) ||
      new Set(customers.map((customer) => customer.id)).size !== customers.length ||
      customers.some((customer) => !customer.id || !customer.name?.startsWith(ledger.prefix + '-')) ||
      ledger.prefix !== receipt.environment?.runPrefix ||
      cleanup.prefix !== ledger.prefix ||
      cleanup.gate !== 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' ||
      !cleanup.finishedAt ||
      cleanup.businessWrites !== 0 ||
      cleanup.iamKmsOrCapacityWrites !== 0 ||
      cleanup.parentSha256 !== row.createdIdLedger.sha256
    )
      throw Error('RECEIPT_OWNERSHIP_CLEANUP_OR_VERSION_DRIFT');
    const database = JSON.parse(readBoundFile(root, { path: cleanup.databaseReceipt, sha256: cleanup.databaseSha256 }));
    if (
      database.result?.prefix !== ledger.prefix ||
      database.result?.empty !== true ||
      ['devices', 'certificates', 'onboardingRequests'].some(
        (key) => !Array.isArray(database.result[key]) || database.result[key].length !== 0,
      ) ||
      !cleanup.reads?.length ||
      cleanup.reads.some((entry) => entry.result !== 'PASS') ||
      [...(cleanup.archives ?? []), ...(cleanup.exportObjects ?? [])].some(
        (entry) => entry.versions !== 0 || entry.markers !== 0 || entry.truncated !== false,
      ) ||
      !cleanup.identities?.length ||
      cleanup.identities.some((entry) => entry.count !== 0) ||
      !cleanup.builds?.length ||
      cleanup.builds.some((entry) => !['SUCCEEDED', 'FAILED', 'STOPPED'].includes(entry.status))
    )
      throw Error('INDEPENDENT_CLEANUP_CONTENT_NOT_PASSED');
    return [];
  } catch (error) {
    return [error.message];
  }
}
/** All legacy CLIs retain HEAD binding unless an explicit, fully checked sidecar is supplied. */
export function runTargetEvidenceCli(root, validator, path, check, success) {
  try {
    const context = process.env.FDP_QA09_BINDINGS
      ? validateTargetBindings(root, JSON.parse(readFileSync(resolve(root, process.env.FDP_QA09_BINDINGS))))
      : undefined;
    const bound = context?.formalReceipts.find((row) => row.validator === validator);
    const sourceCommit =
      context?.versions.application.sourceCommit ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const errors = check(root, bound?.receipt.path ?? path, sourceCommit, context);
    errors.forEach((error) => process.stderr.write(error + '\n'));
    if (!errors.length) process.stdout.write(success + '\n');
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
