/** Replay specialized validators offline, then assemble formal receipts for the explicitly reduced phase. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { collectCloseout } from './collect-qa09-a678-closeout.mjs';
import { collectMinimum } from './collect-qa09-a4678-minimum.mjs';
import { checkMinimumAssociations } from './check-qa09-minimum-associations.mjs';
import {
  digest,
  validateMinimumPhaseScope,
  validateMinimumPhaseFacts,
  MINIMUM_DOMAINS,
  MINIMUM_LIMITS,
  summarizeMinimumPhase,
} from './qa09-minimum-phase-policy.mjs';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export const EXECUTOR_FILES = [
  'scripts/qa09-minimum-phase-policy.mjs',
  'scripts/collect-qa09-minimum-phase.mjs',
  'scripts/check-qa09-minimum-phase.mjs',
  'scripts/check-qa09-acceptance.mjs',
  'scripts/collect-qa09-a678-closeout.mjs',
  'scripts/collect-qa09-a4678-minimum.mjs',
  'scripts/check-qa09-minimum-associations.mjs',
  'scripts/check-qa09-a5-closeout.mjs',
  'scripts/qa09-a467-proof.mjs',
  'scripts/qa09-closeout-ledger.mjs',
  'scripts/qa09-partial-domain-receipt.mjs',
  'scripts/qa09-business-reconciliation.mjs',
  'scripts/qa09-user-closeout-browser.mjs',
  'scripts/qa09-esg-closeout.mjs',
  'scripts/qa09-minimum-a5-proof.mjs',
  'scripts/qa09-minimum-association-gate.mjs',
  'scripts/qa09-natural-summary-association.mjs',
  'scripts/check-qa09-minimum-a5.mjs',
  'scripts/qa09-reliability-closeout.mjs',
  'scripts/qa09-replay-production-proof.mjs',
  'scripts/qa09-persistence-audit.mjs',
  'scripts/check-qa09-business-target.mjs',
  'scripts/qa09-nonactive-cleanup.mjs',
  'scripts/collect-qa09-nonactive-semantics.mjs',
  'scripts/qa09-formal-closeout-map.mjs',
  'scripts/recover-qa09-a5-cleanup.mjs',
  'scripts/collect-qa09-operator-actor-binding.mjs',
  'pnpm-lock.yaml',
];
export const DOCUMENT_FILES = [
  'docs/audit/QA-09-最小范围验收完成-2026-10-14.md',
  'docs/audit/QA-09-当前验收入口.md',
  'infra/environments/qa09-minimum-cloud.json',
  'docs/dev/QA-09-运营最小材料清单.md',
  'docs/dev/QA-09-发布前必验清单.md',
];
export function snapshot(paths) {
  const files = paths.map((path) => ({ path, sha256: digest(readFileSync(path)) }));
  return { files, sha256: digest(JSON.stringify(files)) };
}
const boundRead = (path, refs) => {
  demand(!path.split('/').includes('..') && !path.startsWith('/'), 'REPOSITORY_RELATIVE_EVIDENCE_REQUIRED');
  const full = realpathSync(path);
  demand(!relative(realpathSync('.'), full).startsWith('..'), 'EVIDENCE_OUTSIDE_REPOSITORY');
  const b = readFileSync(full);
  refs.push({ path, sha256: digest(b) });
  return JSON.parse(b);
};
export async function replayMinimumPhaseEvidence(inputs, outputDir) {
  const refs = [];
  const read = (p) => boundRead(p, refs);
  const original = read('docs/audit/evidence/qa-09-a1-entry-2026-10-13/scope.json');
  const scope = read(inputs.scopePath);
  validateMinimumPhaseScope(
    scope,
    original,
    digest(readFileSync('docs/audit/evidence/qa-09-a1-entry-2026-10-13/scope.json')),
  );
  const version = read(inputs.versionPath),
    config = read(inputs.configPath);
  demand(
    version.gate === 'PASS' &&
      version.lambdaArtifacts.length === 19 &&
      version.lambdaArtifacts.every((a) => a.matches) &&
      version.pendingDeployment.conclusion === 'success' &&
      version.sourceCommit === '74089df0df214ca61528a3f48b25e4534c358980',
    'CURRENT_VERSION_AND_ARTIFACTS_REQUIRED',
  );
  const priorConfig = read('build/qa09-private-a678-followup-20261014/api-config-after-layout-deploy.json');
  demand(
    config.CodeSha256 === version.lambdaArtifacts.find((a) => a.name === 'fdp-test-api').codeSha256 &&
      config.State === 'Active' &&
      config.LastUpdateStatus === 'Successful' &&
      config.MemorySize === priorConfig.MemorySize &&
      isDeepStrictEqual(config.Environment.Variables, priorConfig.Environment.Variables),
    'CURRENT_CONFIG_DRIFT',
  );
  // Exact prior bytes are a source baseline, not free-form acceptance flags.
  const priorPath = 'docs/audit/evidence/qa09-a678-closeout-2026-10-14/a8-summary.json';
  const prior = read(priorPath);
  demand(
    digest(readFileSync(priorPath)) ===
      digest(execFileSync('git', ['show', '06af6991454c2bff3dbbc525f3f791c9ef026035:' + priorPath])) &&
      prior.minimumPhaseAccepted === false,
    'SEALED_PRIOR_PARTIAL_MUST_REMAIN',
  );
  for (const source of [inputs.a678Dir, inputs.a467Dir, inputs.a5Dir])
    demand(
      /^build\/qa09-private-[a-zA-Z0-9-]+\/$/.test(source) && existsSync(source),
      'EXACT_EXISTING_RAW_BUNDLE_REQUIRED',
    );
  const a678 = await collectCloseout(inputs.a678Dir, join(outputDir, 'a678-recheck.json'));
  const a467 = collectMinimum(inputs.a467Dir, join(outputDir, 'a467-recheck.json'), 'target-v3.json');
  const a5 = checkMinimumAssociations(inputs.a5Dir, join(outputDir, 'a5-recheck.json'));
  for (const ref of a678.refs) {
    demand(digest(readFileSync(ref.file)) === ref.sha256, 'REPLAY_SOURCE_REF_DRIFT');
    refs.push({ path: ref.file, sha256: ref.sha256 });
  }
  for (const ref of a467.bindings) {
    demand(digest(readFileSync(ref.file)) === ref.sha256, 'REPLAY_A467_REF_DRIFT');
    refs.push({ path: ref.file, sha256: ref.sha256 });
  }
  for (const ref of a5.localBindings) {
    const path = inputs.a5Dir + ref.file;
    demand(digest(readFileSync(path)) === ref.sha256, 'REPLAY_A5_REF_DRIFT');
    refs.push({ path, sha256: ref.sha256 });
  }
  const priorA5 = read(inputs.a5Dir + 'prior-a5-recheck.json');
  for (const ref of priorA5.bindings) {
    demand(digest(readFileSync(ref.path)) === ref.sha256, 'A5_SPECIALIZED_RAW_BINDING_DRIFT');
    refs.push(ref);
  }
  // Execute the original three-criterion checker; metadata with a PASS string is insufficient.
  const oldA5 = 'docs/audit/evidence/qa-09-a2-a5-2026-10-13/';
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/check-qa09-a5-closeout.mjs',
      oldA5 + 'a5-target.json',
      oldA5 + 'final-readonly.json',
      oldA5 + 'application-version.json',
      join(outputDir, 'a5-three-recheck.json'),
      oldA5 + 'operator-actor-binding.json',
      oldA5 + 'a5-cleanup-recovery-v2.json',
    ],
    { stdio: 'pipe', timeout: 60000 },
  );
  const three = JSON.parse(readFileSync(join(outputDir, 'a5-three-recheck.json')));
  demand(three.gate === 'PASS_THREE_A5_SUPPLEMENTAL_CRITERIA', 'REAL_REPLAY_AND_DEDUP_RECHECK_REQUIRED');
  demand(
    a467.rotationAccepted &&
      a467.userEvidence?.accepted !== false &&
      a467.required
        .filter((r) =>
          ['users.signedSessionAndState', 'data.naturalEsgConsistency', 'data.exportLeaseRecovery'].includes(r.id),
        )
        .every((r) => r.status === 'PASS'),
    'SPECIALIZED_ROTATION_USER_DATA_PROOFS_REQUIRED',
  );
  demand(
    a678.applicationCommit === version.sourceCommit &&
      a5.gate === 'PASS_FIVE_MINIMUM_A5_SUPPLEMENTAL_CRITERIA' &&
      a5.closed.length === 5,
    'MINIMUM_EVIDENCE_APPLICATION_BINDING_REQUIRED',
  );
  const equalBackend = a678.sourceCompatibility.filter(
    (c) =>
      c.sourceCommit === a5.applicationCommit &&
      [
        'apps/cloud-api',
        'apps/ingestion-worker',
        'packages',
        'contracts/rest',
        'infra/src',
        'pnpm-lock.yaml',
        '.nvmrc',
      ].includes(c.path),
  );
  demand(
    new Set(equalBackend.map((c) => c.path)).size === 7 && equalBackend.every((c) => c.equal === true),
    'OLD_DATA_PROOF_BACKEND_INPUT_DRIFT',
  );
  demand(
    a678.persistence.rows
      .filter((r) => r.status === 'UNAVAILABLE_INPUT_NOT_ACCEPTED')
      .every((r) => ['inviteUser', 'triggerUserPasswordReset', 'updateSetting'].includes(r.operationId)),
    'ONLY_AUTHORIZED_MATERIAL_OPERATIONS_MAY_DEFER',
  );
  const browser = a678.browser;
  const workflowSource = read(
    'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/business.json.browser.json',
  );
  const families = [
    ['alias-write-readback', 'device-operate.alias', [['PATCH', /\/metadata$/, 200]]],
    [
      'contract-create-bind',
      'contract-new.submit',
      [
        ['POST', /\/admin\/contracts$/, 201],
        ['POST', /\/devices\/bind$/, 201],
      ],
    ],
    [
      'consumable-process-complete',
      'device-consumable.requests',
      [
        ['POST', /\/process$/, 200],
        ['POST', /\/complete$/, 200],
      ],
    ],
    [
      'device-user-create-update',
      'settings.device-users',
      [
        ['POST', /\/admin\/device-users$/, 201],
        ['PATCH', /\/admin\/device-users\/[^/]+$/, 200],
      ],
    ],
    ['nonempty-csv-export', 'esg-device.export', [['POST', /\/exports$/, 202]]],
  ];
  demand(
    workflowSource.apiMock === false &&
      workflowSource.sessionMutation === false &&
      families.every(([, group, actions]) =>
        [375, 1440].every((width) => {
          const execution = workflowSource.executions.find(
            (e) => e.group === group && e.width === width && e.role === 'PlatformSuperAdmin' && e.result === 'PASS',
          );
          return (
            execution &&
            actions.every(([method, pattern, status]) =>
              execution.requests.some(
                (q) => q.method === method && pattern.test(q.path.split('?')[0]) && q.status === status && q.requestId,
              ),
            )
          );
        }),
      ),
    'REAL_RETAINED_MUTATING_BROWSER_EXECUTIONS_REQUIRED',
  );
  const facts = {
    currentApplication: 'PASS_BOUND_CURRENT_DEPLOYMENT_AND_CONFIG',
    rotation: 'PASS_REAL_DUAL_CHANNEL_ROTATION',
    a5: a5.closed.map((r) => r.id),
    userState: 'PASS_FIVE_SIGNED_ROLES_STATE_AUDIT_AND_CLEANUP',
    authorization: {
      invalidBranches: a678.authorizationReuse.invalidInputAnonymousAndRoleBranches,
      forgedSignatures: a678.authorizationReuse.forgedSignatureRejections,
      currentRoles: a678.authorizationReuse.currentRoleControls,
      trustedInvalidClaimsAccepted: false,
    },
    persistence: {
      retained: a678.persistence.counts.PASS_SCOPED_PERSISTENCE,
      deferredA2: a678.persistence.counts.DEFERRED_A2_NOT_ACCEPTED,
      deferredMaterials: a678.persistence.counts.UNAVAILABLE_INPUT_NOT_ACCEPTED,
      notProven: a678.persistence.counts.NOT_PROVEN ?? 0,
    },
    semantics: {
      retained:
        (a678.semantics.counts.PASS_REUSED_ORIGINAL_BROWSER_SCOPE ?? 0) +
        (a678.semantics.counts.PASS_REUSED_SCOPED_USER_BROWSER ?? 0),
      deferredA2: a678.semantics.counts.DEFERRED_A2_SUCCESS_NOT_ACCEPTED,
      deferredMaterials: a678.semantics.counts.UNAVAILABLE_NOTIFICATION_INPUT_NOT_ACCEPTED,
      notProven: a678.semantics.counts.NOT_PROVEN ?? 0,
    },
    browser: {
      originalPass: browser.originalPassCases,
      originalFail: browser.originalFailCases,
      finalLayoutRecheck:
        browser.deployedRepairGate === 'PASS_DEPLOYED_DEVICE_USER_375_EN_SCROLL_REGION' ? 'PASS' : 'FAIL',
      changedViewerRead: browser.changedViewerDeviceUserReadCase.result,
      realLogins: browser.realBrowserLoginCountInOriginalScope,
      retainedWorkflowFamilies: families.map(([id]) => id),
      originalFailurePreserved: browser.originalFailedEvidencePreserved,
    },
    data: {
      naturalConsistency: 'PASS_RETAINED_REAL_DATABASE_CSV_ARCHIVE',
      leaseRecovery: 'PASS_NATURAL_NONEMPTY_EQUAL_CSV',
    },
    cleanup: {
      current: 'PASS_INDEPENDENT_EMPTY_IDENTITY_ABSENCE_AND_OUTSIDE_BASELINE',
      unknownExecution: a678.historicalUnknown.originalStartGate,
      unknownContainment:
        a678.historicalUnknown.gate === 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED' ? 'PASS' : 'FAIL',
      originalFailuresPreserved: a678.originalFailuresPreserved,
    },
    permissionsChanged: a678.permissionChanges,
    fullSuiteRepeated: a678.fullSuiteRepeated,
    fullQa09Accepted: false,
    productionReady: false,
  };
  validateMinimumPhaseFacts(facts);
  const bindings = [...new Map(refs.map((r) => [r.path, r])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    scope,
    version,
    facts,
    bindings,
    priorRequired: a678.required,
    domainPartialInputs: a678.formalReceiptAssembly.domains,
  };
}
export async function assembleMinimumPhase(inputs, outputDir, publicDir) {
  demand(
    !existsSync(join(publicDir, 'a8-summary.json')) && !existsSync(join(outputDir, 'minimum-context.json')),
    'FRESH_MINIMUM_PUBLICATION_REQUIRED',
  );
  mkdirSync(publicDir, { recursive: true });
  const verified = await replayMinimumPhaseEvidence(inputs, outputDir);
  const { scope, version, facts, bindings, priorRequired, domainPartialInputs } = verified;
  const bundle = { rawEvidenceLocalOnly: true, bindings };
  writeFileSync(join(outputDir, 'evidence-bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  const binding = {
    scopeSha256: digest(readFileSync(inputs.scopePath)),
    applicationCommit: version.sourceCommit,
    executorSnapshotSha256: snapshot(EXECUTOR_FILES).sha256,
    documentationSnapshotSha256: snapshot(DOCUMENT_FILES).sha256,
    evidenceBundleSha256: digest(JSON.stringify(bundle)),
  };
  const receipts = Object.entries(MINIMUM_DOMAINS).map(([domain, required], i) => ({
    schemaVersion: '2.0',
    kind: 'QA09_FORMAL_MINIMUM_DOMAIN_RECEIPT',
    domain,
    status: 'PASS_MINIMUM_SCOPE',
    ...binding,
    factsSha256: digest(JSON.stringify(facts)),
    required,
    accepted: required,
    scopeLimit: MINIMUM_LIMITS[domain],
    releaseDeferrals: scope.requirements.filter((r) => r.disposition.startsWith('DEFERRED')).map((r) => r.id),
    materialDependencyDeferrals: scope.materialDeferrals,
    originalValidator: domainPartialInputs[i].validator,
    originalValidatorSha256: domainPartialInputs[i].validatorSha256,
    fullOriginalDomainAccepted: false,
    fullQa09Accepted: false,
    productionReady: false,
  }));
  const gate = summarizeMinimumPhase(receipts, scope, facts, binding);
  const formalReceipts = receipts.map((r) => {
    const path = join(publicDir, r.domain + '-minimum.json');
    writeFileSync(path, JSON.stringify(r, null, 2) + '\n');
    return { domain: r.domain, path, sha256: digest(readFileSync(path)) };
  });
  const required = scope.requirements.map((rule) => ({
    id: rule.id,
    status: rule.disposition === 'RETAINED_REQUIRED' ? 'PASS_MINIMUM_SCOPE' : 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
    retainedProof: rule.disposition === 'RETAINED_REQUIRED' ? 'SPECIALIZED_RAW_VALIDATORS_REPLAYED' : null,
    authorizedExclusion: rule.deferral,
    dependentSubscopeDeferrals: rule.dependentSubscopeDeferrals,
    releaseRequired: rule.releaseRequired,
    priorStatus: priorRequired.find((r) => r.id === rule.id)?.status,
  }));
  const summary = {
    task: 'QA09-A8-MINIMUM-ACCEPTANCE',
    ...gate,
    ...binding,
    scope: scope.scope,
    authorization: scope.authorization,
    facts,
    required,
    retainedRequirementCount: required.filter((r) => r.status === 'PASS_MINIMUM_SCOPE').length,
    deferredRequirementCount: required.filter((r) => r.status === 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED').length,
    materialDeferrals: scope.materialDeferrals,
    formalReceipts,
    originalFailuresPreserved: true,
    scopeReducedExplicitly: true,
    permissionsChanged: false,
    fullSuiteRepeated: false,
    originalLegacyFullReceiptsRewritten: false,
  };
  const summaryPath = join(publicDir, 'a8-summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  const context = {
    schemaVersion: '2.0',
    inputs,
    scopeSha256: binding.scopeSha256,
    executorSnapshot: snapshot(EXECUTOR_FILES),
    documentationSnapshot: snapshot(DOCUMENT_FILES),
    evidenceBundle: bundle,
    formalReceipts,
    summary: { path: summaryPath, sha256: digest(readFileSync(summaryPath)) },
  };
  writeFileSync(join(outputDir, 'minimum-context.json'), JSON.stringify(context, null, 2) + '\n');
  return summary;
}
export async function checkMinimumPhaseContext(context) {
  demand(
    context.schemaVersion === '2.0' &&
      isDeepStrictEqual(context.executorSnapshot, snapshot(EXECUTOR_FILES)) &&
      isDeepStrictEqual(context.documentationSnapshot, snapshot(DOCUMENT_FILES)),
    'MINIMUM_EXECUTOR_OR_DOCUMENTATION_DRIFT',
  );
  demand(digest(readFileSync(context.inputs.scopePath)) === context.scopeSha256, 'MINIMUM_SCOPE_BYTES_DRIFT');
  for (const ref of context.evidenceBundle.bindings)
    demand(digest(readFileSync(ref.path)) === ref.sha256, 'MINIMUM_RAW_EVIDENCE_DRIFT');
  const temp = mkdtempSync(join(resolve('build/qa09-private-a8-minimum-acceptance-20261014'), 'verification-'));
  try {
    const { scope, version, facts, bindings, priorRequired, domainPartialInputs } = await replayMinimumPhaseEvidence(
      context.inputs,
      temp,
    );
    demand(isDeepStrictEqual(bindings, context.evidenceBundle.bindings), 'EXACT_RAW_EVIDENCE_INVENTORY_REQUIRED');
    const binding = {
      scopeSha256: context.scopeSha256,
      applicationCommit: version.sourceCommit,
      executorSnapshotSha256: context.executorSnapshot.sha256,
      documentationSnapshotSha256: context.documentationSnapshot.sha256,
      evidenceBundleSha256: digest(JSON.stringify(context.evidenceBundle)),
    };
    const receipts = context.formalReceipts.map((ref) => {
      demand(digest(readFileSync(ref.path)) === ref.sha256, 'FORMAL_MINIMUM_RECEIPT_BYTES_DRIFT');
      return JSON.parse(readFileSync(ref.path));
    });
    for (const r of receipts) {
      const original = domainPartialInputs[Object.keys(MINIMUM_DOMAINS).indexOf(r.domain)];
      demand(
        original &&
          r.originalValidator === original.validator &&
          r.originalValidatorSha256 === original.validatorSha256,
        'ORIGINAL_DOMAIN_VALIDATOR_BINDING_DRIFT',
      );
    }
    const gate = summarizeMinimumPhase(receipts, scope, facts, binding);
    demand(digest(readFileSync(context.summary.path)) === context.summary.sha256, 'MINIMUM_SUMMARY_BYTES_DRIFT');
    const summary = JSON.parse(readFileSync(context.summary.path));
    const exactRequired = scope.requirements.map((rule) => ({
      id: rule.id,
      status: rule.disposition === 'RETAINED_REQUIRED' ? 'PASS_MINIMUM_SCOPE' : 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
      retainedProof: rule.disposition === 'RETAINED_REQUIRED' ? 'SPECIALIZED_RAW_VALIDATORS_REPLAYED' : null,
      authorizedExclusion: rule.deferral,
      dependentSubscopeDeferrals: rule.dependentSubscopeDeferrals,
      releaseRequired: rule.releaseRequired,
      priorStatus: priorRequired.find((r) => r.id === rule.id)?.status,
    }));
    demand(
      isDeepStrictEqual(summary.required, exactRequired) &&
        summary.retainedRequirementCount === 14 &&
        summary.deferredRequirementCount === 10 &&
        isDeepStrictEqual(summary.formalReceipts, context.formalReceipts) &&
        isDeepStrictEqual(summary.materialDeferrals, scope.materialDeferrals) &&
        summary.authorization === scope.authorization &&
        summary.scope === scope.scope &&
        summary.originalFailuresPreserved === true &&
        summary.permissionsChanged === false &&
        summary.fullSuiteRepeated === false &&
        summary.originalLegacyFullReceiptsRewritten === false &&
        Object.entries(binding).every(([k, v]) => isDeepStrictEqual(summary[k], v)),
      'EXACT_DERIVED_MINIMUM_SUMMARY_REQUIRED',
    );
    demand(
      isDeepStrictEqual(summary.facts, facts) &&
        Object.entries(gate).every(([k, v]) => isDeepStrictEqual(summary[k], v)),
      'MINIMUM_SUMMARY_NOT_DERIVED_FROM_REAL_PROOFS',
    );
    return gate;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputs, outputDir, publicDir] = process.argv.slice(2);
  if (!inputs || !outputDir || !publicDir) throw Error('INPUTS_PRIVATE_OUTPUT_PUBLIC_OUTPUT_REQUIRED');
  const result = await assembleMinimumPhase(JSON.parse(readFileSync(inputs)), outputDir, publicDir);
  console.log(
    JSON.stringify({
      gate: result.gate,
      minimumPhaseAccepted: result.minimumPhaseAccepted,
      retained: result.retainedRequirementCount,
      deferred: result.deferredRequirementCount,
      formal: result.minimumFormalPassCount,
    }),
  );
}
