import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRotationProof, assertTabletProof } from './qa09-a467-proof.mjs';
import { assertScopedSignedSession } from './qa09-business-reconciliation.mjs';
import { validateUserBrowserEvidence } from './qa09-user-closeout-browser.mjs';
import { assertConsistency, assertLeaseRecovery, assertCsvDatabase } from './qa09-esg-closeout.mjs';
import { canReuseReadUi } from './qa09-read-ui-reuse.mjs';
import { summarizeMinimumGate } from './qa09-a8-minimum-gate.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export function collectMinimum(dir, output, targetName = 'target.json') {
  if (!/^target(?:-v[2-9])?\.json$/.test(targetName)) throw Error('EXACT_ATTEMPT_FILENAME_REQUIRED');
  const targetPath = dir + targetName;
  const finalPath = dir + targetName.replace('target', 'final-readonly');
  const bindings = [];
  const read = (path) => {
    const b = readFileSync(path);
    bindings.push({ file: path, sha256: sha(b) });
    return JSON.parse(b);
  };
  const version = read(dir + 'application-version.json'),
    current = read(dir + 'api-config.json');
  demand(
    version.gate === 'PASS' && version.lambdaArtifacts.length === 19 && version.lambdaArtifacts.every((a) => a.matches),
    'CURRENT_APPLICATION_ARTIFACTS_REQUIRED',
  );
  demand(
    current.CodeSha256 === version.lambdaArtifacts.find((a) => a.name === 'fdp-test-api').codeSha256 &&
      current.State === 'Active' &&
      current.LastUpdateStatus === 'Successful',
    'CURRENT_API_CONFIG_BINDING_REQUIRED',
  );
  const oldPath = 'docs/audit/evidence/qa-09-close-01-2026-10-12/user-target-v2.json';
  const old = read(oldPath),
    oldConfig = read('docs/audit/evidence/qa-09-close-01-2026-10-12/api-entry-config.json');
  assertScopedSignedSession(old);
  old.userBrowser.forEach(validateUserBrowserEvidence);
  demand(
    old.userBrowser.length === 2 && old.users.every((u) => u.auditReadback.length > 0),
    'REUSED_USER_AUDIT_AND_BROWSER_REQUIRED',
  );
  const relevant = [
    'apps/cloud-api',
    'apps/admin-web',
    'packages/auth',
    'packages/database',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.nvmrc',
    'infra',
    '.github/workflows/deploy-test.yml',
  ];
  const userCompatibility = relevant.map((path) => {
    const hashes = execFileSync(
      'git',
      ['rev-parse', old.sourceCommit + ':' + path, version.sourceCommit + ':' + path],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    let historyDepthOnly = false;
    if (path === '.github/workflows/deploy-test.yml' && hashes[0] !== hashes[1]) {
      const before = execFileSync('git', ['show', old.sourceCommit + ':' + path], { encoding: 'utf8' });
      const after = execFileSync('git', ['show', version.sourceCommit + ':' + path], { encoding: 'utf8' });
      historyDepthOnly = after.replace(/^[ ]{10}fetch-depth: 0\n/m, '') === before;
    }
    return { path, before: hashes[0], after: hashes[1], equal: hashes[0] === hashes[1], historyDepthOnly };
  });
  demand(
    userCompatibility.every((c) => c.equal || c.historyDepthOnly),
    'RELEVANT_USER_INPUTS_CHANGED_NO_REUSE',
  );
  const vars = current.Environment.Variables;
  const cfg = {
    memory: current.MemorySize,
    envName: vars.ENV_NAME,
    pool: vars.FDP_DB_POOL_MAX,
    engineCpu: vars.FDP_QA09_ENGINE_CPU_DIAGNOSIS,
    preconnect: vars.FDP_QA09_AUTHENTICATED_PRECONNECT,
    accountReadCandidate: vars.FDP_QA09_ACCOUNT_READ_CANDIDATE,
    contractLoadDetail: vars.FDP_QA09_CONTRACT_LOAD_DETAIL,
    contractPublicBoundaries: vars.FDP_QA09_CONTRACT_PUBLIC_BOUNDARIES,
    contractObserverCost: vars.FDP_CONTRACT_OBSERVER_COST,
  };
  demand(
    Object.entries(cfg).every(([k, v]) => oldConfig[k] === v),
    'REUSED_CONFIG_DRIFT',
  );
  const historical = read('docs/audit/evidence/qa-09-close-01-2026-10-12/reconciliation-after.json');
  demand(
    historical.semantic.elements.length === 117 && historical.pairs.length === 112,
    'EXACT_HISTORICAL_LEDGER_REQUIRED',
  );
  const frozen = read('docs/audit/evidence/qa-09-a1-entry-2026-10-13/scope.json');
  const formal = read(dir + 'formal-gate-checks.json');
  demand(
    formal.applicationCommit === version.sourceCommit &&
      formal.cloudRequests === 0 &&
      formal.rows.length === frozen.domains.length &&
      new Set(formal.rows.map((r) => r.validator)).size === frozen.domains.length &&
      formal.rows.every(
        (r) => frozen.domains.some((d) => d.id === r.id && d.validator === r.validator) && Number.isInteger(r.exitCode),
      ),
    'EXACT_EIGHT_ORIGINAL_LOCAL_FORMAL_GATE_RESULTS_REQUIRED',
  );
  const prior = read('docs/audit/evidence/qa09-minimum-2026-10-13/closeout-summary.json');
  demand(
    prior.gate === 'PASS_FIVE_MINIMUM_A5_SUPPLEMENTAL_CRITERIA' && prior.applicationCommit === version.sourceCommit,
    'PRIOR_FIVE_MINIMUM_A5_REQUIRED',
  );
  const firstFinal = read(dir + 'final-readonly.json'),
    recoveredFinal = read(dir + 'v2-recovered-final.json');
  demand(
    firstFinal.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
      firstFinal.parentSha256 === sha(readFileSync(dir + 'target.json')) &&
      recoveredFinal.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
      recoveredFinal.parentSha256 === sha(readFileSync(dir + 'target-v2-recovered.json')) &&
      recoveredFinal.rotationRecovery?.gate === 'PASS_BOUND_CLEANUP_ONLY_ORIGINAL_EXECUTION_NOT_ACCEPTED',
    'PRIOR_ATTEMPTS_INDEPENDENT_CLEANUP_REQUIRED',
  );
  const interrupted = read(dir + 'target-v2-interrupted.json');
  demand(
    interrupted.interruption?.exitCode === 13 &&
      interrupted.executionCompleted === false &&
      interrupted.interruption.originalReceiptSha256 === sha(readFileSync(dir + 'target-v2.json')),
    'ORIGINAL_UNSETTLED_ATTEMPT_MUST_REMAIN_PRESERVED',
  );
  const oldUnknown = read(dir + 'old-unknown-recheck.json');
  let target, final;
  try {
    target = read(targetPath);
    final = read(finalPath);
  } catch {
    /* Missing target never promotes a requirement. */
  }
  let rotation = false,
    tablet = false;
  if (
    target &&
    final &&
    final.gate === 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' &&
    final.parentSha256 === sha(readFileSync(targetPath)) &&
    target.cleanup.every((c) => c.result === 'PASS')
  ) {
    const sources = read(targetPath + '.sources.json');
    demand(
      sources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
      'EXECUTED_TARGET_SOURCE_DRIFT',
    );
    if (target.rotation?.gate === 'PASS_ONE_REAL_DUAL_CHANNEL_ROTATION') {
      assertRotationProof(target.rotation);
      rotation = true;
    }
    if (target.tabletGap?.gate === 'PASS_ROOT_TABLET_BILINGUAL_FOUR_READ_PAGES') {
      assertTabletProof(target.tabletGap.cases);
      demand(target.tabletGap.writes.length === 0 && target.tabletGap.apiMock === false, 'READ_BROWSER_WRITES_OR_MOCK');
      tablet = true;
    }
  }
  let independentTablet;
  try {
    independentTablet = read(dir + 'tablet-only.json');
  } catch {
    /* Missing independent proof remains outstanding. */
  }
  if (independentTablet?.gate === 'PASS') {
    demand(
      independentTablet.scope === 'INDEPENDENT_ROOT_TABLET_READ_ONLY_NO_DEVICE_FIXTURE' &&
        independentTablet.sourceCommit === version.sourceCommit &&
        independentTablet.versionSha256 === sha(readFileSync(dir + 'application-version.json')) &&
        independentTablet.finishedAt &&
        independentTablet.cleanup.length === 1 &&
        independentTablet.cleanup[0].result === 'PASS' &&
        independentTablet.cleanup[0].absent === true &&
        independentTablet.notificationSendingRequested === false,
      'INDEPENDENT_TABLET_BINDING_AND_CLEANUP_REQUIRED',
    );
    const sources = read(dir + 'tablet-only.json.sources.json');
    demand(
      sources.sources.every((s) => sha(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
      'TABLET_EXECUTED_SOURCE_DRIFT',
    );
    assertTabletProof(independentTablet.tabletGap.cases);
    demand(
      independentTablet.tabletGap.writes.length === 0 && independentTablet.tabletGap.apiMock === false,
      'TABLET_MOCK_OR_BUSINESS_WRITES',
    );
    tablet = true;
  }
  const excluded = new Set([
    'device.independentLicenseVerification',
    'device.naturalActive',
    'device.suspendReactivateRetire',
    'license.lifecycle',
    'command.deliveryAndResult',
    'ota.trustedFirmwareAndCampaign',
    'media.realUploadAndIsolation',
  ]);
  const esgBase = 'docs/audit/evidence/qa-09-close-07-esg-2026-10-13/target-v3.json';
  const esg = read(esgBase + '.reliability.json'),
    esgParent = read(esgBase);
  demand(
    esg.gate === 'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY' &&
      esg.businessCleanup === 'PASS' &&
      esg.archive.gate === 'PASS' &&
      esg.archive.result.allReportsArchived &&
      esg.archive.result.allTelemetryArchived,
    'RETAINED_ESG_SCOPE_REQUIRED',
  );
  assertConsistency(esg.finalFrame, esg.telemetry, esg.reports, esgParent.devices, esgParent.customers);
  const before = read(esg.builds[2].receipt).result.exports.find((e) => e.id === esg.leaseRecovery.id),
    after = read(esg.builds[4].receipt).result.exports.find((e) => e.id === esg.leaseRecovery.id);
  const csv = (label) => {
    const path = esgBase + '.' + label + '.csv',
      b = readFileSync(path);
    bindings.push({ file: path, sha256: sha(b) });
    return b.toString();
  };
  assertLeaseRecovery(before, esg.leaseInjection, after, csv('hourly'), csv('hourly-recovered'));
  for (const job of esg.jobs)
    assertCsvDatabase(
      csv(job.dataset.toLowerCase()),
      job.dataset,
      esg.consistencyFrame,
      esgParent.devices[0],
      esgParent.customers[0].id,
    );
  const rows = frozen.mandatorySupplemental.map((r) => {
    if (excluded.has(r.id))
      return {
        id: r.id,
        status: 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED',
        authorizedExclusion: 'REL-A2-01',
        releaseRequired: true,
      };
    if (prior.closed.some((c) => c.id === r.id))
      return { id: r.id, status: 'PASS', proof: 'BOUND_PRIOR_FIVE_MINIMUM_A5_AGGREGATE', scope: prior.scope };
    if (r.id === 'certificate.completeRotation' && rotation)
      return { id: r.id, status: 'PASS', proof: 'REAL_DUAL_CHANNEL_ROTATION_AND_REVOKED_OLD_CERTIFICATE_DENIAL' };
    if (['data.naturalEsgConsistency', 'data.exportLeaseRecovery'].includes(r.id))
      return {
        id: r.id,
        status: 'PASS',
        proof: 'RETAINED_ORIGINAL_SCOPED_DATA_RECHECK_NOT_FRESH_TARGET_REASSESSMENT',
        sourceCommit: esg.sourceCommit,
      };
    if (r.id === 'users.signedSessionAndState')
      return {
        id: r.id,
        status: 'PASS',
        proof: 'REUSED_EXACT_RELEVANT_SOURCE_CONFIG_FIVE_ROLE_STATE_AUDIT_AND_CLEANUP',
        sourceCommit: old.sourceCommit,
      };
    return { id: r.id, status: 'NOT_PROVEN_IN_CURRENT_MINIMUM_SCOPE', criterion: r.criterion };
  });
  // The five supplemental A5 criteria do not waive the original actual retry/DLQ requirement.
  rows.push({
    id: 'actualArchivePoisonRetryDlq',
    status: 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED',
    authorizedExclusion: 'REL-QUEUE-01',
    releaseRequired: true,
  });
  const state = summarizeMinimumGate(rows);
  const semantic = read('docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/semantic-summary.json');
  for (const ref of semantic.receipts) {
    demand(sha(readFileSync(ref.path)) === ref.sha256, 'ORIGINAL_SEMANTIC_BYTES_DRIFT');
    bindings.push({ file: ref.path, sha256: ref.sha256 });
  }
  demand(
    semantic.scopeGate === 'PASS' && semantic.cleanup === 'PASS' && semantic.elements.length === 117,
    'ORIGINAL_SCOPED_SEMANTICS_REQUIRED',
  );
  const readPaths = [
    'apps/admin-web/src/pages',
    'apps/admin-web/src/api',
    'apps/admin-web/src/router',
    'apps/admin-web/src/shell',
    'apps/admin-web/src/i18n',
    'apps/admin-web/src/auth/auth-flow.ts',
    'apps/admin-web/src/session',
    'packages/auth',
    'packages/database/prisma',
    'contracts/rest',
    'contracts/lifecycle',
    'pnpm-lock.yaml',
    '.nvmrc',
    'apps/cloud-api/src/admin/device',
    'apps/cloud-api/src/admin/device-console',
    'apps/cloud-api/src/admin/dashboard',
    'apps/cloud-api/src/admin/esg',
    'apps/cloud-api/src/consumable',
  ];
  const readCompatibility = readPaths.map((path) => {
    const [before, after] = execFileSync(
      'git',
      ['rev-parse', semantic.sourceCommit + ':' + path, version.sourceCommit + ':' + path],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    return { path, before, after, equal: before === after };
  });
  const readGroups = new Set([
    'dashboard.summary',
    'dashboard.collections',
    'device-view.scope',
    'device-view.console',
    'device-group.filters',
    'device-group.columns',
    'device-group.manage',
    'device-manage.back',
    'device-consumable.filters',
    'device-consumable.columns',
    'device-consumable.contact',
    'esg-overview.period',
    'esg-overview.columns',
    'esg-device.scope',
    'esg-device.period',
    'esg-device.metrics',
  ]);
  const reusableReads = new Set();
  if (
    tablet &&
    readCompatibility.every((p) => p.equal) &&
    [
      'preconnect',
      'accountReadCandidate',
      'contractLoadDetail',
      'contractPublicBoundaries',
      'contractObserverCost',
    ].every((k) => cfg[k] === 'false')
  ) {
    for (const e of semantic.elements) {
      if (canReuseReadUi(e, readGroups, true, tablet)) reusableReads.add(e.id);
    }
  }
  const result = {
    task: 'QA09-A8',
    scope: 'MINIMUM_WITHOUT_NEW_PERMISSION_CHANNELS',
    applicationCommit: version.sourceCommit,
    ...state,
    required: rows,
    rotationAccepted: rotation,
    tabletSupplementAccepted: tablet,
    userEvidence: {
      gate: 'PASS_REUSED_RELEVANT_SOURCE_AND_CONFIG_SCOPED_USER_STATE',
      sourceCommit: old.sourceCommit,
      compatibility: userCompatibility,
      runtimeArtifactBytesIdenticalClaimed: false,
      currentApiConfigMatches: true,
      repeatedFiveRole129Checks: false,
    },
    prototypeLedger: historical.semantic.elements.map((e) => ({
      id: e.id,
      group: e.group,
      historicalStatus: e.result,
      currentStatus: reusableReads.has(e.id)
        ? 'PASS_REUSED_ROOT_READ_UI_SCOPE_SOURCE_AND_CONFIG_BOUND'
        : historical.semanticSupplement.some((s) => s.id === e.id)
          ? 'PASS_REUSED_SCOPED_USER_BROWSER'
          : 'HISTORICAL_ONLY_REQUIRES_DOMAIN_COMPATIBILITY_AND_FORMAL_ASSEMBLY',
    })),
    readUiReuse: {
      scope: 'UNCHANGED_ROOT_READ_CONTROLS_ONLY_NOT_MUTATING_WORKFLOWS_OR_ALL_ROLES',
      count: reusableReads.size,
      compatibility: readCompatibility,
      successfulCurrentRootLoginAndReadControl: tablet,
      candidateFlagsRemainOff: true,
      databasePoolAndObservationChanges:
        'NO_NEW_PERFORMANCE_OR_PERSISTENCE_CLAIM; ORIGINAL_READ_QUERY_AND_DTO_SCOPE_ONLY',
    },
    operationRoleLedger: historical.pairs.map((p) => ({
      operationId: p.operationId,
      role: p.role,
      historicalHttpSuccess: p.historicalHttpSuccess,
      currentPersistenceAcceptance:
        p.role === 'PlatformSuperAdmin' && ['assignUserRoles', 'setUserScope', 'disableUser'].includes(p.operationId)
          ? 'PASS_REUSED_USER_STATE_AUDIT_SCOPE'
          : 'NOT_IMPLIED_BY_HTTP; REUSE_SCOPED_DOMAIN_PROOFS_OR_COMPLETE_FORMAL_ASSEMBLY',
    })),
    formalDomains: formal.rows.map((d) => ({
      id: d.id,
      validator: d.validator,
      status: d.exitCode === 0 ? 'ORIGINAL_VALIDATOR_PASS' : 'FULL_ORIGINAL_RECEIPT_NOT_ASSEMBLED',
      exitCode: d.exitCode,
      fullOriginalGatePassed: d.exitCode === 0,
    })),
    narrowerTabletProof: '768_ZH_EN_FOUR_ROOT_READ_PAGES_ONLY_NOT_ALL_ROLES_OR_ALL_WORKFLOWS',
    signedInvalidClaims:
      'NOT_RUN_NO_CURRENT_TRUSTED_SIGNATURE_FIXTURES_FOR_EXP_NBF_AUDIENCE; FORGED_SIGNATURE_REJECTIONS_NOT_SUBSTITUTE',
    notifications: 'NOT_RUN_EXISTING_NO_NOTIFICATION_SEND_AUTHORIZATION_PRESERVED',
    settings: 'NOT_RUN_NO_OWNED_SETTING_RESTORE_SCOPE',
    a6InputAvailability: {
      source: 'USER_REPLY_2026_10_14_UNAVAILABLE',
      trustedSignedInvalidClaims: 'UNAVAILABLE',
      controlledNotificationRecipientAndScope: 'UNAVAILABLE',
      writableRestorableSettingKey: 'UNAVAILABLE',
      scopeWaiverOrPassInferred: false,
      newChannelsOrPermissionsRequested: false,
    },
    media: 'ACTIVE_MAINTENANCE_REQUIRED_BY_DEPLOYED_SOURCE; NO_SQL_ACTIVE_OR_FAKE_VERIFIED',
    dataReuse: {
      gate: 'RETAINED_ORIGINAL_SCOPED_PASS',
      freshTargetValueReassessment: false,
      sourceCommit: esg.sourceCommit,
    },
    currentTargetGate: target?.gate ?? 'NO_RECEIPT',
    independentCleanupGate: final?.gate ?? 'NO_RECEIPT',
    priorAttemptsCleanup: {
      first: firstFinal.gate,
      interruptedRecovery: recoveredFinal.gate,
      originalInterruptedExecutionAccepted: false,
    },
    historicalUnknownWrite: {
      gate: oldUnknown.gate,
      originalUnknownStart: 'UNKNOWN',
      absenceProvesNonExecution: false,
      restarted: false,
    },
    iamKmsOrSharedPermissionChanges: false,
    ownDevicePolicyLifecycleOnly: true,
    fullSuiteRepeated: false,
    originalFailuresPreserved: true,
    releasePerformanceAccepted: false,
    fullEvidenceLocalOnly: true,
    bindings,
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(collectMinimum(...process.argv.slice(2)).gate);
