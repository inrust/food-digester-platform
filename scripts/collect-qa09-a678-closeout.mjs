import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectNonActive } from './collect-qa09-nonactive-semantics.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
import { assertScopedSignedSession } from './qa09-business-reconciliation.mjs';
import { validateUserBrowserEvidence } from './qa09-user-closeout-browser.mjs';
import { persistenceLedger, mapSemanticElements, assertContainment } from './qa09-closeout-ledger.mjs';
import { FORMAL_VALIDATORS } from './qa09-formal-closeout-map.mjs';
import ts from 'typescript';
import { MUTATION_AUDIT_ACTIONS, bindSuccessfulAudit } from './qa09-persistence-audit.mjs';
import { validateNonActiveParentCleanup } from './qa09-nonactive-cleanup.mjs';
import { validatePartialDomainReceipt } from './qa09-partial-domain-receipt.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export async function collectCloseout(
  dir,
  output,
  targetName = 'target-v2.json',
  auditName = 'persistence-audit-v3.json',
) {
  if (
    existsSync(output) ||
    !/^target-v[2-9]\.json$/.test(targetName) ||
    !/^persistence-audit-v[3-9]\.json$/.test(auditName)
  )
    throw Error('FRESH_EXACT_CLOSEOUT_OUTPUT_REQUIRED');
  const refs = [];
  const read = (file) => {
    const b = readFileSync(file);
    refs.push({ file, sha256: sha(b) });
    return JSON.parse(b);
  };
  const executionVersion = read(dir + 'application-version.json');
  const version = existsSync(dir + 'application-version-after-layout-deploy.json')
      ? read(dir + 'application-version-after-layout-deploy.json')
      : executionVersion,
    config = read(
      dir +
        (existsSync(dir + 'api-config-after-layout-deploy.json')
          ? 'api-config-after-layout-deploy.json'
          : 'api-config.json'),
    );
  validateBusinessVersion(version, version.sourceCommit);
  demand(
    config.CodeSha256 === version.lambdaArtifacts.find((x) => x.name === 'fdp-test-api').codeSha256 &&
      config.State === 'Active' &&
      config.LastUpdateStatus === 'Successful',
    'CURRENT_API_BINDING_REQUIRED',
  );
  const oldConfig = read('build/qa09-private-a4678-20261014/api-config.json');
  demand(
    config.MemorySize === oldConfig.MemorySize &&
      JSON.stringify(config.Environment.Variables) === JSON.stringify(oldConfig.Environment.Variables),
    'CURRENT_CONFIGURATION_DRIFT',
  );
  const prior = read('docs/audit/evidence/qa09-a4678-minimum-2026-10-14/a8-summary.json');
  demand(
    sha(readFileSync('docs/audit/evidence/qa09-a4678-minimum-2026-10-14/a8-summary.json')) ===
      sha(
        execFileSync('git', [
          'show',
          '2a549e5184cb049878484e115ea11ea7d228a3b5:docs/audit/evidence/qa09-a4678-minimum-2026-10-14/a8-summary.json',
        ]),
      ),
    'FROZEN_PRIOR_A8_BYTES_REQUIRED',
  );
  demand(
    prior.applicationCommit === executionVersion.sourceCommit &&
      prior.minimumPhaseAccepted === false &&
      prior.fullQa09Accepted === false,
    'PRIOR_A8_VERSION_BOUNDARY_REQUIRED',
  );
  const target = read(dir + targetName),
    parent = read(dir + targetName + '.fixtures.json'),
    gate = read(dir + targetName + '.gate.json'),
    domain = read(dir + targetName + '.domain-cleanup.json');
  demand(
    ['PASS', 'FAIL'].includes(target.gate) &&
      target.finishedAt &&
      target.cleanupComplete &&
      target.remaining?.finishedAt &&
      target.remaining.checks.every((c) => c.result === 'PASS') &&
      parent.gate === 'PASS' &&
      (gate.gate === 'PASS' || (gate.gate === 'FAIL' && gate.reason === 'REMAINING_TARGET_INCOMPLETE')) &&
      domain.gate === 'PASS' &&
      target.cleanup.every((c) => c.result === 'PASS') &&
      parent.cleanup.every((c) => c.result === 'PASS') &&
      target.sourceCommit === executionVersion.sourceCommit,
    'CURRENT_SCOPED_EXECUTION_AND_CLEANUP_REQUIRED',
  );
  demand(
    domain.parentReceiptSha256 === sha(readFileSync(dir + targetName + '.fixtures.json')),
    'DOMAIN_PARENT_BINDING_REQUIRED',
  );
  validateNonActiveParentCleanup(parent);
  const executed = read(dir + targetName + '.sources.json');
  demand(
    executed.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'EXECUTED_SOURCE_BYTES_REQUIRED',
  );
  validateBusinessDatabaseReceipts(
    target,
    target.databaseBuilds.map((b) => read(b.receipt)),
  );
  const first = read(dir + 'target.json'),
    firstParent = read(dir + 'target.json.fixtures.json'),
    firstDomain = read(dir + 'target.json.domain-cleanup.json');
  demand(
    first.gate === 'FAIL' &&
      first.remaining?.checks.some((c) => c.id === 'contract-bind-persisted' && c.result === 'FAIL') &&
      first.cleanupComplete &&
      firstParent.gate === 'PASS' &&
      firstDomain.gate === 'PASS' &&
      first.prefix === firstParent.prefix &&
      firstDomain.prefix === firstParent.prefix &&
      firstDomain.parentReceiptSha256 === sha(readFileSync(dir + 'target.json.fixtures.json')) &&
      first.cleanup.every((c) => c.result === 'PASS'),
    'ORIGINAL_FAILED_ATTEMPT_AND_CLEANUP_MUST_REMAIN',
  );
  validateNonActiveParentCleanup(firstParent);
  validateBusinessDatabaseReceipts(
    first,
    first.databaseBuilds.map((b) => read(b.receipt)),
  );
  const emptyChecks = [];
  for (const [file, p] of [
    ['independent-empty-first.json', firstParent],
    ['independent-empty-v2-recovered.json', parent],
  ]) {
    const r = read(dir + file),
      prep = read(dir + file + '.preparation.json');
    const originalBaseline = read(p.databaseBuilds.find((b) => b.action === 'observe').receipt).result
      .originalFingerprints;
    demand(
      r.gate === 'PASS' &&
        r.result?.gate === 'PASS' &&
        r.result.empty === true &&
        r.result.action === 'audit-empty' &&
        r.result.prefix === p.prefix &&
        r.sourceHash === sha(readFileSync('scripts/qa09-ten-device-db.mjs')) &&
        r.result.sourceHash === r.sourceHash &&
        r.result.buildId === r.build.id &&
        prep.plan.action === 'audit-empty' &&
        prep.plan.prefix === p.prefix &&
        JSON.stringify(prep.plan.devices) === JSON.stringify(p.devices) &&
        JSON.stringify(prep.plan.customers) === JSON.stringify(p.customers) &&
        JSON.stringify(prep.plan.baseline) === JSON.stringify(originalBaseline) &&
        JSON.stringify(r.result.originalFingerprints) === JSON.stringify(originalBaseline) &&
        r.result.emptyCounts.length === 14 &&
        r.result.emptyCounts.every((x) => x.count === 0),
      'INDEPENDENT_EXACT_EMPTY_SET_AND_OUTSIDE_BASELINE_REQUIRED',
    );
    emptyChecks.push({
      file: dir + file,
      receiptSha256: sha(readFileSync(dir + file)),
      gate: 'PASS',
      empty: true,
      action: 'READ_ONLY_AUDIT_EMPTY',
    });
  }
  const rejectedEmptyStart = read(dir + 'independent-empty-v2.json');
  const trail = read(dir + 'empty-start-cloudtrail.json').Events.map((e) => JSON.parse(e.CloudTrailEvent));
  demand(
    rejectedEmptyStart.gate === 'FAIL' &&
      rejectedEmptyStart.failure.kind === 'START_OUTCOME_UNCONFIRMED' &&
      trail.some(
        (e) =>
          e.eventTime === '2026-10-14T03:12:25Z' &&
          e.errorCode === 'AccountLimitExceededException' &&
          e.requestParameters.projectName === 'fdp-test-qa09-ten-device-fixtures' &&
          !e.responseElements,
      ),
    'FAILED_START_AND_READ_ONLY_DIAGNOSIS_MUST_REMAIN',
  );
  const audit = read(dir + auditName);
  demand(
    audit.gate === 'PASS' &&
      audit.sourceCommit === executionVersion.sourceCommit &&
      audit.cleanup.length === 1 &&
      audit.cleanup[0].absent === true &&
      audit.cleanup[0].result === 'PASS' &&
      audit.persistenceAudits.businessWrites === 0,
    'READ_ONLY_AUDIT_AND_IDENTITY_CLEANUP_REQUIRED',
  );
  const auditSources = read(dir + auditName + '.sources.json');
  demand(
    auditSources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'AUDIT_EXECUTED_SOURCE_REQUIRED',
  );
  if (audit.persistenceAudits.prior) {
    const p = read(audit.persistenceAudits.prior.file);
    demand(
      sha(readFileSync(audit.persistenceAudits.prior.file)) === audit.persistenceAudits.prior.sha256 &&
        p.gate === 'PASS' &&
        p.cleanup[0].absent === true,
      'PRIOR_AUDIT_BINDING_REQUIRED',
    );
  }
  const ledger = read('docs/audit/evidence/qa-09-close-01-2026-10-12/reconciliation-after.json');
  const security = read(
    'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/security-summary.json',
  );
  demand(
    security.gate === 'PASS' &&
      security.operationCount === 63 &&
      security.expectedRoleRequests === 378 &&
      security.rows.length === 378 &&
      new Set(security.rows.map((r) => r.operationId + ':' + r.role)).size === 378 &&
      security.rows.every((r) => r.result === 'PASS') &&
      security.signedClaimValidationIndependentlyProven === false &&
      security.cleanup === 'PASS',
    'ORIGINAL_SCOPED_AUTHORIZATION_MATRIX_REQUIRED',
  );
  const securityInputs = security.receipts.map((ref) => {
    demand(sha(readFileSync(ref.path)) === ref.sha256, 'ORIGINAL_SECURITY_BYTES_DRIFT');
    return read(ref.path);
  });
  const [securityOriginal, securityRetest, securityGate] = securityInputs;
  demand(
    securityGate.gate === 'PASS' &&
      securityOriginal.cleanupComplete &&
      securityOriginal.remaining.checks.some(
        (c) => c.id === 'invalid-writes-no-business-effects' && c.result === 'PASS',
      ) &&
      securityOriginal.remaining.checks.some((c) => c.id === 'audit-no-token-private-key' && c.result === 'PASS'),
    'SCOPED_SECURITY_NO_EFFECTS_AND_CREDENTIAL_SCAN_REQUIRED',
  );
  for (const row of security.rows) {
    const initial = securityOriginal.remaining.writeBoundaries.rows.find(
      (r) => r.operationId === row.operationId && r.role === row.role,
    );
    demand(initial, 'ORIGINAL_BOUNDARY_ROW_REQUIRED');
    if (initial.result !== 'PASS')
      demand(
        ['retireDevice:CustomerViewer', 'createFirmwareUpload:CustomerAdmin'].includes(
          row.operationId + ':' + row.role,
        ) &&
          securityRetest.checks.some(
            (c) =>
              c.id === 'security-retest:' + row.operationId + ':' + row.role &&
              c.result === 'PASS' &&
              c.status === 403 &&
              c.requestId,
          ),
        'EXACT_RECOVERED_PERMISSION_REQUEST_REQUIRED',
      );
  }
  demand(
    securityRetest.checks.filter(
      (c) =>
        c.id.startsWith('security-retest:jwt-') && c.result === 'PASS' && [401, 403].includes(c.status) && c.requestId,
    ).length === 6,
    'FORGED_SIGNATURE_SCOPE_REQUIRED',
  );
  const oldBrowserPath = 'docs/audit/evidence/qa-09-business-target-attempt2-2026-10-03.json',
    oldBrowser = read(oldBrowserPath),
    oldBrowserSources = read(oldBrowserPath + '.sources.json');
  demand(
    [...oldBrowserSources.sources, ...oldBrowser.sources].every(
      (s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256,
    ) &&
      Object.entries(oldBrowser.sourceHashes).every(([path, digest]) =>
        [...oldBrowserSources.sources, ...oldBrowser.sources].some((s) => s.path === path && s.sha256 === digest),
      ) &&
      oldBrowser.cleanupComplete &&
      oldBrowser.stages.browser === 'PASS' &&
      oldBrowser.checks.filter((c) => c.stage === 'browser').every((c) => c.result === 'PASS') &&
      ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'].every((role) =>
        oldBrowser.checks.some((c) => c.id === role + ':browser-srp-login' && c.result === 'PASS'),
      ),
    'FIVE_ROLE_REAL_BROWSER_ORIGINAL_SCOPE_REQUIRED',
  );
  demand(
    audit.persistenceAudits.ledgerSha256 ===
      sha(readFileSync('docs/audit/evidence/qa-09-close-01-2026-10-12/reconciliation-after.json')),
    'AUDIT_REQUEST_LEDGER_DRIFT',
  );
  const original = collectNonActive('docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed');
  for (const ref of original.receipts) {
    demand(sha(readFileSync(ref.path)) === ref.sha256, 'ORIGINAL_EVIDENCE_BYTES_DRIFT');
    refs.push({ file: ref.path, sha256: ref.sha256 });
  }
  const signedPath = 'docs/audit/evidence/qa-09-close-01-2026-10-12/user-target-v2.json',
    signed = read(signedPath);
  assertScopedSignedSession(signed);
  signed.userBrowser.forEach(validateUserBrowserEvidence);
  const comparisons = [];
  const runtimePaths = [
    'apps/cloud-api',
    'apps/ingestion-worker',
    'packages',
    'contracts/rest',
    'infra/src',
    'pnpm-lock.yaml',
    '.nvmrc',
  ];
  const runtimeEqual = runtimePaths.every((path) => {
    const hashes = execFileSync(
      'git',
      ['rev-parse', executionVersion.sourceCommit + ':' + path, version.sourceCommit + ':' + path],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    comparisons.push({
      sourceCommit: executionVersion.sourceCommit,
      path,
      before: hashes[0],
      after: hashes[1],
      equal: hashes[0] === hashes[1],
    });
    return hashes[0] === hashes[1];
  });
  demand(runtimeEqual, 'LAYOUT_DEPLOYMENT_CHANGED_BACKEND_INPUTS');
  const controlledContractHelper = ['create', 'update', 'activate'].every((step) =>
    target.remaining.checks.some((c) => c.id === 'contract-' + step + '-persisted' && c.result === 'PASS'),
  );
  function unchangedContractFunction(commit, op) {
    if (!controlledContractHelper || op === 'updateContract') return false;
    const file = 'apps/cloud-api/src/admin/contract/service.ts';
    const nodes = [commit, version.sourceCommit].map((c) => {
      const text = execFileSync('git', ['show', c + ':' + file], { encoding: 'utf8' }),
        source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const node = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === op);
      return node ? sha(node.getText(source)) : null;
    });
    const equal = !!nodes[0] && nodes[0] === nodes[1];
    comparisons.push({
      sourceCommit: commit,
      path: file,
      functionName: op,
      before: nodes[0],
      after: nodes[1],
      equal,
      scope: 'PUBLIC_OPERATION_BODY_ONLY_SHARED_HELPER_CURRENT_LIVE_CONTROL_NOT_WHOLE_MODULE_EQUALITY',
    });
    return equal;
  }
  function compatible(commit, paths) {
    return paths
      .map((path) => {
        const hashes = execFileSync('git', ['rev-parse', commit + ':' + path, version.sourceCommit + ':' + path], {
          encoding: 'utf8',
        })
          .trim()
          .split('\n');
        const row = { sourceCommit: commit, path, before: hashes[0], after: hashes[1], equal: hashes[0] === hashes[1] };
        comparisons.push(row);
        return row.equal;
      })
      .every(Boolean);
  }
  function onlyDeviceUserScrollWrapperChanged(commit) {
    const dir = 'apps/admin-web/src/pages',
      file = dir + '/device-users/DeviceUsersPage.tsx';
    const changed = execFileSync('git', ['diff', '--name-only', commit, version.sourceCommit, '--', dir], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (changed.length !== 1 || changed[0] !== file) return false;
    const before = execFileSync('git', ['show', commit + ':' + file], { encoding: 'utf8' }),
      after = execFileSync('git', ['show', version.sourceCommit + ':' + file], { encoding: 'utf8' });
    const unwrapped = after.replace(
      /<div className="table-scroll" role="region" aria-label=\{translate\('page\.2993d42bd8c9'\)\} tabIndex=\{0\}>\s*(<table[^]*?data-testid="device-user-table"[^]*?<\/table>)\s*<\/div>/,
      '$1',
    );
    if (unwrapped === after) return false;
    const compile = (text) =>
      ts.transpileModule(text, {
        compilerOptions: { jsx: ts.JsxEmit.React, removeComments: true, target: ts.ScriptTarget.ES2022 },
      }).outputText;
    const equal = compile(before) === compile(unwrapped);
    comparisons.push({
      sourceCommit: commit,
      path: file,
      equalAfterScrollWrapperRemoval: equal,
      scope: 'ONLY_PRESENTATION_WRAPPER_NO_CONTROL_OR_NETWORK_LOGIC_CHANGE',
      before: sha(compile(before)),
      after: sha(compile(unwrapped)),
    });
    return equal;
  }
  const common = ['packages/auth', 'packages/database/prisma', 'contracts/rest', 'pnpm-lock.yaml', '.nvmrc'];
  function domainPaths(op) {
    if (/Customer/.test(op)) return ['apps/cloud-api/src/admin/customer'];
    if (/Site/.test(op)) return ['apps/cloud-api/src/admin/site'];
    if (op === 'updateDeviceMetadata') return ['apps/cloud-api/src/admin/device'];
    if (op === 'assignDevice') return ['apps/cloud-api/src/admin/device-assignment'];
    if (/Configuration/.test(op)) return ['apps/cloud-api/src/admin/configuration'];
    if (/License/.test(op)) return ['apps/cloud-api/src/admin/license'];
    if (/DeviceUser/.test(op)) return ['apps/cloud-api/src/admin/device-user'];
    if (/Alarm/.test(op)) return ['apps/cloud-api/src/admin/alarm'];
    if (/Consumable/.test(op)) return ['apps/cloud-api/src/consumable'];
    if (op === 'createReplayJob') return ['apps/cloud-api/src/admin/replay'];
    if (op === 'createEsgExport') return ['apps/cloud-api/src/admin/esg'];
    if (op === 'createActivityExport') return ['apps/cloud-api/src/admin/device-console'];
    if (/ContractDevices/.test(op)) return ['apps/cloud-api/src/admin/contract-device'];
    if (/Contract/.test(op)) return ['apps/cloud-api/src/admin/contract'];
    return [];
  }
  const proofs = [];
  const add = (operationId, role, file, proofKind, sourceCompatible, extra = {}) =>
    proofs.push({
      operationId,
      role,
      receipt: file,
      receiptSha256: sha(readFileSync(file)),
      proofKind,
      sourceCompatible,
      cleanupVerified: true,
      specializedValidation: 'PASS',
      ...extra,
    });
  for (const p of audit.persistenceAudits.matched) {
    demand(
      bindSuccessfulAudit(
        { requestId: p.mutationRequestId, role: p.role, operationId: p.operationId },
        { ...p, requestId: p.mutationRequestId, actorRole: p.role, result: 'SUCCESS' },
      ),
      'ATOMIC_AUDIT_AFTER_SNAPSHOT_REQUIRED',
    );
    demand(
      ledger.pairs.some(
        (row) =>
          row.operationId === p.operationId &&
          row.role === p.role &&
          row.evidence.some((e) => e.requestId === p.mutationRequestId && e.sourceCommit === p.sourceCommit),
      ),
      'AUDIT_OPERATION_ROLE_REQUEST_CONFLICT',
    );
    const paths = domainPaths(p.operationId);
    if (!paths.length) continue;
    if (MUTATION_AUDIT_ACTIONS[p.operationId])
      demand(p.action === MUTATION_AUDIT_ACTIONS[p.operationId], 'AUDIT_ACTION_NOT_OPERATION');
    const commonCompatible = compatible(p.sourceCommit, common);
    const exact = compatible(p.sourceCommit, paths);
    add(
      p.operationId,
      p.role,
      dir + auditName,
      'ATOMIC_AUDIT_SNAPSHOT',
      commonCompatible &&
        (exact || (/Contract$/.test(p.operationId) && unchangedContractFunction(p.sourceCommit, p.operationId))),
      { action: p.action, auditDetailSha256: sha(JSON.stringify(p)), artifactBytesIdenticalClaimed: false },
    );
  }
  const contractMap = {
    createContract: 'create',
    updateContract: 'update',
    activateContract: 'activate',
    renewContract: 'renew',
    evaluateContract: 'evaluate',
    terminateContract: 'terminate',
    bindContractDevices: 'bind',
    unbindContractDevices: 'unbind',
  };
  for (const role of ['PlatformSuperAdmin', 'PlatformOperator']) {
    const id = 'remaining:license-evaluate-' + role;
    const q = securityOriginal.checks.find(
      (c) =>
        c.id === id && c.role === role && c.result === 'PASS' && c.method === 'POST' && c.status === 200 && c.requestId,
    );
    demand(
      q &&
        securityOriginal.remaining.checks.some(
          (c) => c.id === 'license-issued-no-fake-activation-' + role && c.result === 'PASS',
        ),
      'ISSUED_LICENSE_EVALUATION_GUARD_REQUIRED',
    );
    const issue = audit.persistenceAudits.matched.find(
      (p) =>
        p.operationId === 'issueLicense' &&
        p.role === role &&
        q.path === '/api/v1/admin/licenses/' + p.objectId + '/evaluate',
    );
    demand(issue, 'LICENSE_EVALUATION_MUST_MATCH_OWN_AUDITED_ISSUED_ENTITY');
    add(
      'evaluateLicense',
      role,
      security.receipts[0].path,
      'NONACTIVE_LICENSE_EVALUATION_READBACK',
      compatible(securityOriginal.sourceCommit, [...common, 'apps/cloud-api/src/admin/license']),
      { scope: 'SERVER_ISSUED_STATE_ONLY_NOT_INDEPENDENT_DEVICE_VERIFICATION_OR_NATURAL_ACTIVE' },
    );
  }
  for (const [op, step] of Object.entries(contractMap)) {
    if (target.remaining.checks.some((c) => c.id === 'contract-' + step + '-persisted' && c.result === 'PASS'))
      add(op, 'PlatformSuperAdmin', dir + targetName, 'CURRENT_CONTRACT_STATE_READBACK', true);
  }
  demand(
    signed.users.every((u) => u.auditReadback.length > 0),
    'USER_STATE_AUDIT_REQUIRED',
  );
  for (const op of ['assignUserRoles', 'setUserScope', 'disableUser'])
    add(
      op,
      'PlatformSuperAdmin',
      signedPath,
      'SCOPED_SIGNED_USER_AUDIT',
      compatible(signed.sourceCommit, ['apps/cloud-api', 'packages/auth', 'packages/database']),
    );
  for (const op of ['approveOnboardingRequest', 'rejectOnboardingRequest'])
    add(
      op,
      'PlatformSuperAdmin',
      'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/csr.json',
      'REAL_CSR_ENTITY_RECEIPT',
      compatible(original.sourceCommit, [...common, 'apps/cloud-api/src/admin/onboarding']),
    );
  add(
    'createCertificateRotationRequest',
    'PlatformSuperAdmin',
    'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/certificate.json',
    'REAL_CSR_ENTITY_RECEIPT',
    compatible(original.sourceCommit, [...common, 'apps/cloud-api/src/admin/certificate-rotation']),
  );
  const pairs = persistenceLedger(ledger.pairs, proofs);
  const uiPaths = [
    'apps/admin-web/src/pages',
    'apps/admin-web/src/api',
    'apps/admin-web/src/router',
    'apps/admin-web/src/shell',
    'apps/admin-web/src/i18n',
    'apps/admin-web/src/session',
    ...common,
  ];
  const uiCompatible =
    compatible(
      original.sourceCommit,
      uiPaths.filter((p) => p !== 'apps/admin-web/src/pages'),
    ) &&
    (compatible(original.sourceCommit, ['apps/admin-web/src/pages']) ||
      onlyDeviceUserScrollWrapperChanged(original.sourceCommit));
  const viewerGap = read(dir + 'viewer-device-user-gap-v2.json');
  const viewerFailed = read(dir + 'viewer-device-user-gap.json');
  const viewerSources = read(dir + 'viewer-device-user-gap-v2.json.sources.json');
  demand(
    viewerFailed.gate === 'FAIL' &&
      viewerFailed.cleanup.length === 3 &&
      viewerFailed.cleanup.every((c) => c.result === 'PASS' && c.absent === true) &&
      viewerSources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'ORIGINAL_EMPTY_SCOPE_HARNESS_FAILURE_AND_SOURCE_MUST_REMAIN',
  );
  demand(
    viewerGap.gate === 'PASS' &&
      viewerGap.sourceCommit === version.sourceCommit &&
      viewerGap.versionSha256 === sha(readFileSync(dir + 'application-version-after-layout-deploy.json')) &&
      viewerGap.finishedAt &&
      viewerGap.cleanup.length === 3 &&
      viewerGap.cleanup.every((c) => c.result === 'PASS' && c.absent === true) &&
      viewerGap.viewerDeviceUser?.gate === 'PASS_DEPLOYED_VIEWER_DEVICE_USER_EMPTY_SCOPE_375_EN' &&
      viewerGap.viewerDeviceUser.role === 'CustomerViewer' &&
      viewerGap.viewerDeviceUser.writes.length === 0 &&
      viewerGap.viewerDeviceUser.layout.documentWidth <= 376 &&
      viewerGap.viewerDeviceUser.layout.locale === 'en',
    'CHANGED_VIEWER_READ_ROUTE_REAL_CURRENT_PROOF_REQUIRED',
  );
  const routeFile = 'apps/admin-web/src/router/routes.ts';
  const routeBefore = execFileSync('git', ['show', oldBrowser.sourceCommit + ':' + routeFile], { encoding: 'utf8' });
  const routeAfter = execFileSync('git', ['show', version.sourceCommit + ':' + routeFile], { encoding: 'utf8' });
  const normalizedRoutes = routeAfter
    .replace("import { hasPermission } from '@fdp/auth/browser';", '')
    .replace(
      "roles: ALL_ROLES.filter((role) => hasPermission(role, 'device-user:read'))",
      "roles: ['PlatformSuperAdmin', 'Auditor', 'CustomerAdmin']",
    );
  const compileRoutes = (source) =>
    ts.transpileModule(source, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022 } })
      .outputText;
  demand(
    compatible(securityOriginal.sourceCommit, ['packages/auth', 'contracts/rest']) &&
      compatible(oldBrowser.sourceCommit, ['packages/auth']) &&
      compileRoutes(routeBefore) === compileRoutes(normalizedRoutes),
    'ONLY_EXACT_VERIFIED_VIEWER_ROUTE_CHANGE_MAY_BE_EXCLUDED_FROM_REUSE',
  );
  comparisons.push({
    path: routeFile,
    sourceCommit: oldBrowser.sourceCommit,
    scope: 'ONLY_DEVICE_USER_VIEWER_READ_ADDITION_CURRENT_TARGET_VERIFIED_OLD_DENIED_CASE_EXCLUDED',
    before: sha(compileRoutes(routeBefore)),
    afterNormalized: sha(compileRoutes(normalizedRoutes)),
    compatibleExceptVerifiedViewerAddition: true,
  });
  const groupCompatibility = Object.fromEntries(original.elements.map((e) => [e.group, uiCompatible]));
  const elements = mapSemanticElements(
    original.elements,
    ['settings.button.deletePlatformUser', 'settings.modal.confirm'],
    groupCompatibility,
    true,
  );
  const supplement = read(dir + 'role-supplement.json');
  demand(
    supplement.gate === 'PASS' &&
      supplement.sourceCommit === executionVersion.sourceCommit &&
      supplement.finishedAt &&
      supplement.cleanup.length === 6 &&
      supplement.cleanup.every((c) => c.result === 'PASS' && c.absent === true),
    'ROLE_SUPPLEMENT_AND_ALL_IDENTITY_CLEANUP_REQUIRED',
  );
  const supplementSources = read(dir + 'role-supplement.json.sources.json');
  demand(
    supplementSources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'ROLE_SUPPLEMENT_SOURCE_BINDING_REQUIRED',
  );
  const containment = assertContainment(supplement.unknownContainment);
  const browser = target.remaining.browser;
  const roleBrowser = supplement.browserSupplement;
  const rootGap = read(dir + 'root-browser-gaps.json');
  demand(
    rootGap.gate === 'FAIL' &&
      rootGap.sourceCommit === executionVersion.sourceCommit &&
      rootGap.cleanup.length === 1 &&
      rootGap.cleanup[0].absent === true &&
      rootGap.cleanup[0].result === 'PASS',
    'ORIGINAL_ROOT_LAYOUT_FAILURE_AND_CLEANUP_REQUIRED',
  );
  const rootGapSources = read(dir + 'root-browser-gaps.json.sources.json');
  demand(
    rootGapSources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'ROOT_GAP_EXECUTED_SOURCE_REQUIRED',
  );
  const allCases = [...browser.cases, ...rootGap.browserGap.cases, ...roleBrowser.cases];
  const failedLayout = allCases.filter((c) => c.result === 'FAIL');
  demand(
    failedLayout.length === 1 &&
      failedLayout[0].route === '/device-users' &&
      failedLayout[0].locale === 'en' &&
      failedLayout[0].width === 375 &&
      failedLayout[0].documentWidth === 723,
    'EXACT_ORIGINAL_LAYOUT_FAILURE_REQUIRED',
  );
  const layoutRecheck = read(dir + 'device-user-layout-recheck-v2.json');
  demand(
    layoutRecheck.gate === 'PASS' &&
      layoutRecheck.sourceCommit === version.sourceCommit &&
      layoutRecheck.versionSha256 === sha(readFileSync(dir + 'application-version-after-layout-deploy.json')) &&
      layoutRecheck.cleanup.length === 1 &&
      layoutRecheck.cleanup[0].absent === true &&
      layoutRecheck.layoutRecheck?.gate === 'PASS_DEPLOYED_DEVICE_USER_375_EN_SCROLL_REGION' &&
      layoutRecheck.layoutRecheck.domMutation === false &&
      layoutRecheck.layoutRecheck.writes.length === 0,
    'ACTUAL_DEPLOYED_LAYOUT_RECHECK_REQUIRED',
  );
  const layoutSources = read(dir + 'device-user-layout-recheck-v2.json.sources.json');
  demand(
    layoutSources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
    'DEPLOYED_RECHECK_SOURCE_REQUIRED',
  );
  demand(
    roleBrowser.gate === 'PASS' &&
      roleBrowser.cases.length === 8 &&
      roleBrowser.writes.length === 0 &&
      browser.apiMock === false &&
      browser.sessionMutation === false &&
      browser.writes.length === 0 &&
      new Set(allCases.map((c) => c.role)).size === 5 &&
      allCases.filter((c) => c.role === 'PlatformSuperAdmin').length === 80 &&
      allCases.filter((c) => c.result === 'PASS').every((c) => c.documentWidth <= c.width + 1),
    'CURRENT_BROWSER_DIFFERENCE_PROOFS_REQUIRED',
  );
  const domains = [];
  for (const validator of FORMAL_VALIDATORS) {
    const path = 'scripts/' + validator,
      source = readFileSync(path, 'utf8'),
      module = await import(pathToFileURL(resolve(path)));
    const required = Object.fromEntries(
      Object.entries(module).filter(
        ([k]) => k.startsWith('REQUIRED_') || ['UPLINK_TYPES', 'QA03_PROBES', 'RETIRED_MQTT_TYPES'].includes(k),
      ),
    );
    const probePaths = [
      ...new Set([...source.matchAll(/receipt\??\.probes\??\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1])),
    ];
    const requiredOperations = [
      ...new Set(
        Object.entries(required)
          .filter(([k, v]) => k.includes('OPERATIONS') && Array.isArray(v))
          .flatMap(([, v]) => v),
      ),
    ];
    const requiredWorkflows = [
      ...new Set(
        Object.entries(required)
          .filter(([k, v]) => k.includes('WORKFLOWS') && Array.isArray(v))
          .flatMap(([, v]) => v),
      ),
    ];
    const requiredRoutes = [
      ...new Set(
        Object.entries(required)
          .filter(([k, v]) => k.includes('ROUTES') && Array.isArray(v))
          .flatMap(([, v]) => v),
      ),
    ];
    const semanticPrefixes = validator.includes('admin-cus-dev')
      ? ['device-view', 'device-operate', 'device-group', 'device-manage']
      : validator.includes('admin-business')
        ? ['contract-', 'device-consumable', 'esg-', 'settings.device-users']
        : validator.includes('med-rbac')
          ? ['dashboard', 'settings.platform']
          : validator === 'check-admin-web-target-evidence.mjs'
            ? ['device-view', 'device-group', 'device-manage', 'settings.device-users']
            : validator.includes('fe11-15')
              ? ['device-operate', 'esg-']
              : validator.includes('fe16-19')
                ? ['settings.platform', 'contract-', 'device-consumable']
                : [];
    const domainReceipt = {
      validator: path,
      validatorSha256: sha(source),
      kind: 'PARTIAL_DOMAIN_RECEIPT_ASSEMBLY_NOT_LEGACY_PASS_RECEIPT',
      status: 'PARTIAL_NOT_ACCEPTED',
      requiredSets: required,
      probePaths,
      originalValidatorModified: false,
      fullOriginalGatePassed: false,
      operationCoverage: requiredOperations.map((operationId) => ({
        operationId,
        roleRows: pairs
          .filter((p) => p.operationId === operationId)
          .map((p) => ({ role: p.role, status: p.status, proofs: p.proofs })),
        uncoveredReadOrAncillaryRequirement: pairs.every((p) => p.operationId !== operationId)
          ? 'ORIGINAL_SCHEMA_OR_HTTP_READ_RECEIPT_STILL_AUTHORITATIVE_NOT_A_WRITE_LEDGER_PASS'
          : null,
      })),
      routeCoverage: requiredRoutes.map((route) => ({
        route,
        newLayoutCases: allCases
          .filter((c) => c.route === route)
          .map((c) => ({ role: c.role, width: c.width, locale: c.locale, originalResult: c.result })),
        deployedRepair: route === '/device-users' ? layoutRecheck.layoutRecheck.gate : null,
        scope: 'READ_ROUTE_LAYOUT_ONLY_NOT_MUTATING_WORKFLOW',
      })),
      workflowCoverage: requiredWorkflows.map((workflowId) => ({
        workflowId,
        status: 'SCOPED_OBSERVATIONS_ASSEMBLED_FULL_ORIGINAL_WORKFLOW_NOT_ACCEPTED',
        retainA2AndUnavailableInputBoundaries: true,
      })),
      probeCoverage: probePaths.map((path) => ({
        path,
        status: 'PARTIAL_SCOPED_OBSERVATIONS_NOT_FULL_ORIGINAL_PROBE',
        originalValidatorAndAncillaryConstraintsStillRequired: true,
      })),
      evidence: {
        operationRoles: pairs
          .filter((p) => p.status === 'PASS_SCOPED_PERSISTENCE' && requiredOperations.includes(p.operationId))
          .map((p) => p.operationId + ':' + p.role),
        semanticItems: elements
          .filter((e) => e.status.startsWith('PASS_') && semanticPrefixes.some((p) => e.group.startsWith(p)))
          .map((e) => e.id),
        semanticAssociationScope: 'RELEVANT_SCOPED_BROWSER_GROUPS_ONLY_NOT_PROTOCOL_OR_FULL_PROBE_PROOF',
        priorA5:
          validator === 'check-aws-data-processing-evidence.mjs'
            ? prior.required
                .filter((r) => r.status === 'PASS' && /^(replay\.|reliability\.|data\.)/.test(r.id))
                .map((r) => r.id)
            : [],
      },
      unavailableInputs: prior.a6InputAvailability,
      originalFailuresPreserved: true,
      fullQa09Accepted: false,
    };
    validatePartialDomainReceipt(domainReceipt, {
      validator: path,
      validatorSha256: sha(source),
      requiredSets: required,
      probePaths,
    });
    domains.push(domainReceipt);
  }
  const count = (rows) =>
    Object.fromEntries(
      [...new Set(rows.map((r) => r.status))].map((s) => [s, rows.filter((r) => r.status === s).length]),
    );
  const transientCleanups = [
    'persistence-audit.json',
    'persistence-audit-v2.json',
    'persistence-audit-v3.json',
    'device-user-layout-preview.json',
    'root-browser-gaps.json',
    'device-user-layout-recheck.json',
    'device-user-layout-recheck-v2.json',
  ].map((file) => {
    const r = read(dir + file);
    demand(
      r.finishedAt && r.cleanup.length === 1 && r.cleanup[0].result === 'PASS' && r.cleanup[0].absent === true,
      'EVERY_TRANSIENT_IDENTITY_MUST_BE_ABSENT',
    );
    return {
      file: dir + file,
      receiptSha256: sha(readFileSync(dir + file)),
      cleanup: 'PASS_IDENTITY_ABSENT',
      originalGate: r.gate,
    };
  });
  const eligibleUnproven = pairs.filter((p) => p.status === 'NOT_PROVEN');
  demand(
    eligibleUnproven.length === 0 && elements.every((e) => e.status !== 'NOT_PROVEN'),
    'ELIGIBLE_PERSISTENCE_OR_SEMANTIC_GAP_REMAINS',
  );
  const dependencies = {
    'security.signedClaimsAndIsolation': ['trustedSignedInvalidClaims'],
    'business.operationsRolesPersistence': ['controlledNotificationRecipientAndScope', 'writableRestorableSettingKey'],
    'notifications.inviteAndPasswordApi': ['controlledNotificationRecipientAndScope'],
    'settings.authorizedWriteAndRestore': ['writableRestorableSettingKey'],
    'prototype.117SemanticItems': ['controlledNotificationRecipientAndScope'],
    'browser.targetJourneys': ['controlledNotificationRecipientAndScope', 'writableRestorableSettingKey'],
  };
  const required = prior.required.map((r) => ({
    ...r,
    ...(r.id === 'cleanup.ownedResourcesAndUnknownWrites'
      ? { status: 'PASS', basis: 'CURRENT_EXACT_EMPTY_SETS_AND_IDENTITY_ABSENCE_HISTORICAL_UNKNOWN_CONTAINED_ONLY' }
      : {}),
    ...(dependencies[r.id]
      ? {
          status: 'BLOCKED_UNAVAILABLE_INPUT_NOT_ACCEPTED',
          remainingInputDependencies: dependencies[r.id],
          independentSubscopeCompleted: true,
          fullOriginalScopeAccepted: false,
        }
      : {}),
  }));
  const result = {
    task: 'QA09-A6-A7-A8-CLOSEOUT',
    applicationCommit: version.sourceCommit,
    gate: 'PARTIAL_MINIMUM_QA09_NOT_ACCEPTED',
    minimumPhaseAccepted: false,
    fullQa09Accepted: false,
    productionReady: false,
    executorBinding: {
      collector: 'scripts/collect-qa09-a678-closeout.mjs',
      collectorSha256: sha(readFileSync(import.meta.filename)),
      applicationAndDocumentationVersionSeparated: true,
    },
    required,
    requiredStatusCounts: count(required),
    remainingRootCauses: Object.keys(prior.a6InputAvailability).filter(
      (k) => prior.a6InputAvailability[k] === 'UNAVAILABLE',
    ),
    completedIndependentWork: [
      'eligibleOperationRolePersistence',
      'all117SemanticDispositions',
      'remainingReadRouteLayoutAndRoleControls',
      'historicalUnknownContainment',
      'eightTypedPartialDomainAssemblies',
    ],
    cleanup: {
      gate: 'PASS_SCOPED_CURRENT_RESOURCES_AND_CONTAINMENT',
      independentEmptyChecks: emptyChecks,
      transientIdentityChecks: transientCleanups,
      rejectedStartPreserved: true,
      rejectionDiagnosedByCloudTrail: 'AccountLimitExceededException',
      capacityOrPermissionChanged: false,
    },
    persistence: { counts: count(pairs), rows: pairs },
    authorizationReuse: {
      scope: security.scope,
      operationCount: 63,
      invalidInputAnonymousAndRoleBranches: 378,
      forgedSignatureRejections: 6,
      signedInvalidClaimsIndependentlyProven: false,
      currentRoleControls: 5,
      currentSignedAccountStateScopeRetained: true,
      originalFailedRequestsPreserved: true,
    },
    semantics: {
      mappingComplete: elements.length === 117,
      counts: count(elements),
      elements,
      absence: original.absence,
      originalDataProvenance: original.dataProvenance,
    },
    browser: {
      gapCases: allCases.length,
      changedViewerDeviceUserReadCase: {
        role: 'CustomerViewer',
        route: '/device-users',
        width: 375,
        locale: 'en',
        result: 'PASS',
        oldDeniedCaseReused: false,
        businessWrites: 0,
      },
      originalPassCases: allCases.filter((c) => c.result === 'PASS').length,
      originalFailCases: 1,
      deployedRepairRechecks: 2,
      firstDeployedRecheckGate: 'FAIL_DIAGNOSTIC_ASSERTION_NOT_FULLY_OBSERVED',
      stabilityClaimed: false,
      deployedRepairGate: layoutRecheck.layoutRecheck.gate,
      originalFailedEvidencePreserved: true,
      currentRoles: 5,
      countsByDimension: Object.fromEntries(
        Object.entries(Object.groupBy(allCases, (c) => c.width + ':' + c.locale)).map(([k, v]) => [k, v.length]),
      ),
      businessWrites: 0,
      scope: browser.scope,
      fullWorkflowAcceptanceClaimed: false,
      originalFiveRoleRoutesAndSiteEditScopeReused: true,
      realBrowserLoginCountInOriginalScope: 5,
    },
    historicalUnknown: containment,
    formalReceiptAssembly: {
      complete: domains.length === 8,
      completionScope:
        'EIGHT_TYPED_PARTIAL_DOMAIN_RECEIPTS_WITH_REQUIRED_SETS_AND_EXPLICIT_UNACCEPTED_ANCILLARY_FIELDS_NOT_EIGHT_FORMAL_PASSES',
      domains,
      fullOriginalGatesPassed: 0,
      fullOriginalGatesRequired: 8,
    },
    unavailableInputs: prior.a6InputAvailability,
    sourceCompatibility: comparisons,
    sharedRuntimeChanges:
      'SCOPED_FUNCTIONAL_REUSE_WITH_CURRENT_REAL_API_AND_ROLE_CONTROLS_NOT_IDENTICAL_RUNTIME_BYTES_OR_PERFORMANCE',
    originalFailuresPreserved: true,
    permissionChanges: false,
    fullSuiteRepeated: false,
    refs,
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await collectCloseout(...process.argv.slice(2));
  console.log(
    JSON.stringify({
      gate: r.gate,
      persistence: r.persistence.counts,
      semantics: r.semantics.counts,
      browser: r.browser.gapCases,
      formalReceipts: 8,
    }),
  );
}
