import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconcileLegalWrites, signedWriteRows } from './qa09-business-reconciliation.mjs';
import { validateUserBrowserEvidence } from './qa09-user-closeout-browser.mjs';
import { validateBusinessVersion } from './check-qa09-business-target.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const paths = [
  'apps',
  'packages',
  'contracts',
  'infra',
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  '.nvmrc',
  'scripts/esgiot-cdk.mjs',
  '.github/workflows/deploy-test.yml',
];
export function compareApplicationInputs(sourceCommit, targetCommit) {
  for (const v of [sourceCommit, targetCommit]) if (!/^[a-f0-9]{40}$/.test(v)) throw Error('EXACT_COMMIT_REQUIRED');
  return paths.map((path) => {
    const [before, after] = execFileSync('git', ['rev-parse', `${sourceCommit}:${path}`, `${targetCommit}:${path}`], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    const changed =
      before === after
        ? []
        : execFileSync('git', ['diff', '--name-only', sourceCommit, targetCommit, '--', path], { encoding: 'utf8' })
            .trim()
            .split('\n')
            .filter(Boolean);
    return { path, before, after, equal: before === after, changedFiles: changed };
  });
}
export function collectBusinessReconciliation(output, targetCommit, freshSignedFile) {
  if (existsSync(output)) throw Error('FRESH_RECONCILIATION_OUTPUT_REQUIRED');
  const refs = [];
  const bind = (path) => {
    const bytes = readFileSync(path);
    refs.push({ path, sha256: sha(bytes) });
    return JSON.parse(bytes);
  };
  const legalPath = 'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/legal-coverage.json';
  const legal = bind(legalPath);
  for (const file of legal.sourceReceipts) bind(file);
  const semanticPath = 'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/semantic-summary.json';
  const semantic = bind(semanticPath);
  for (const ref of semantic.receipts) {
    const bytes = readFileSync(ref.path);
    if (sha(bytes) !== ref.sha256) throw Error('SEMANTIC_SOURCE_BYTES_DRIFT');
    refs.push(ref);
  }
  const receipts = [];
  let freshSemantic = [];
  const comparisons = {};
  const comparison = (commit) => (comparisons[commit] ??= compareApplicationInputs(commit, targetCommit));
  const compatibility = (commit) =>
    comparison(commit).every((p) => p.equal)
      ? 'SOURCE_EQUIVALENT_HISTORICAL_CONFIG_NOT_CURRENT_ACCEPTANCE'
      : 'CHANGED_SHARED_OR_DOMAIN_INPUTS_REVALIDATE';
  for (const [sourceCommit, fields] of [
    [legal.currentSourceCommit, ['current']],
    [legal.historicalSourceCommit, ['historical', 'historicalEntity']],
  ]) {
    receipts.push({
      path: legalPath,
      sha256: refs.find((r) => r.path === legalPath).sha256,
      sourceCommit,
      compatibility: compatibility(sourceCommit),
      cleanup: 'HISTORICAL_SCOPE_SEE_ORIGINAL_CLEANUP',
      scope: 'HISTORICAL_CUMULATIVE_HTTP_LEDGER',
      rows: legal.operations.flatMap((o) =>
        o.roles.flatMap((r) =>
          fields.flatMap((field) => {
            const view = field === 'current' ? r : r[field];
            return (view?.checks ?? [])
              .filter((q) => q.requestId)
              .map((q) => ({ ...q, operationId: o.operationId, role: r.role, result: 'PASS' }));
          }),
        ),
      ),
    });
  }
  for (const [file, fresh] of [
    ['docs/audit/evidence/qa-09-continuation-2026-10-04/signed-session-target.json', false],
    ...(freshSignedFile ? [[freshSignedFile, true]] : []),
  ]) {
    const r = bind(file);
    const source = bind(file + '.sources.json');
    for (const s of source.sources)
      if (sha(Buffer.from(s.sourceBase64, 'base64')) !== s.sha256) throw Error('EXECUTED_SOURCE_BYTES_DRIFT');
    const versionFile = fresh
      ? output.replace(/[^/]+$/, '') + 'application-version.json'
      : 'docs/audit/evidence/qa-09-continuation-2026-10-04/application-version.json';
    const v = bind(versionFile);
    if (sha(readFileSync(versionFile)) !== r.applicationVersionReceiptSha256 || v.sourceCommit !== r.sourceCommit)
      throw Error('SIGNED_VERSION_RECEIPT_DRIFT');
    if (fresh) {
      validateBusinessVersion(v, targetCommit);
      if (r.userBrowser?.length !== 2 || new Set(r.userBrowser.map((b) => b.width)).size !== 2)
        throw Error('BOTH_BROWSER_VIEWPORTS_REQUIRED');
      r.userBrowser.forEach(validateUserBrowserEvidence);
      freshSemantic = ['settings.button.deletePlatformUser', 'settings.modal.confirm'].map((id) => ({
        id,
        result: 'PASS',
        sourceCommit: r.sourceCommit,
        receipt: file,
        viewports: r.userBrowser.map((b) => b.width),
        proof: 'SUPPRESSED_TEST_IDENTITY_REAL_BROWSER_CANCEL_DISABLE_AND_API_READBACK',
      }));
      for (const u of r.users)
        if (
          !u.auditReadback?.length ||
          !r.checks.some((c) => c.id === u.role + ':mutation-audit-persisted' && c.result === 'PASS')
        )
          throw Error('FRESH_USER_AUDIT_READBACK_REQUIRED');
    }
    if (
      fresh &&
      (r.sourceCommit !== targetCommit ||
        v.gate !== 'PASS' ||
        r.fixtureBuilds?.length !== 5 ||
        new Set(r.fixtureBuilds.map((b) => b.role)).size !== 5 ||
        r.notificationSendingRequested !== false ||
        r.invitationAcceptanceClaimed !== false)
    )
      throw Error('FRESH_SIGNED_TARGET_BINDING_REQUIRED');
    for (const b of r.fixtureBuilds ?? []) {
      const proof = bind(b.receipt);
      const own = r.users.find((u) => u.role === b.role);
      const prep = bind(b.receipt + '.preparation.json');
      if (
        sha(readFileSync(b.receipt)) !== b.sha256 ||
        b.gate !== 'PASS' ||
        proof.gate !== 'PASS' ||
        proof.build.status !== 'SUCCEEDED' ||
        proof.result.prefix !== r.prefix ||
        proof.result.action !== 'business-seed-user' ||
        !own ||
        proof.result.user.userId !== own.userId ||
        prep.plan.ownUser.userId !== own.userId ||
        prep.plan.ownUser.email !== own.email ||
        prep.plan.ownUser.role !== own.role ||
        prep.plan.ownUser.customerId !== own.customerId ||
        proof.sourceHash !== source.sources.find((s) => s.path === 'scripts/qa09-ten-device-db.mjs')?.sha256
      )
        throw Error('SIGNED_FIXTURE_BUILD_NOT_BOUND');
    }
    receipts.push({
      path: file,
      sha256: refs.find((x) => x.path === file).sha256,
      sourceCommit: r.sourceCommit,
      compatibility: fresh ? 'CURRENT_LIVE_VERSION_BOUND' : compatibility(r.sourceCommit),
      cleanup: 'PASS',
      scope: r.scope,
      rows: signedWriteRows(r),
    });
  }
  const currentRoot = 'docs/audit/evidence/qa-09-ad213fa-r0-r1-2026-10-12';
  for (const mode of ['r0', 'r1']) {
    const unit = bind(`${currentRoot}/${mode}/unit-completion.json`);
    const file = `${currentRoot}/${mode}/sample.json`,
      r = bind(file);
    if (
      unit.originalExecutionGate !== 'PASS' ||
      unit.cleanup !== 'PASS' ||
      unit.independentEmptyAudit !== 'PASS' ||
      sha(readFileSync(file)) !== unit.bindings['sample.json'] ||
      !r.cleanupComplete
    )
      throw Error('CURRENT_BUSINESS_CLEANUP_BINDING_REQUIRED');
    receipts.push({
      path: file,
      sha256: sha(readFileSync(file)),
      sourceCommit: r.sourceCommit,
      compatibility: compatibility(r.sourceCommit),
      cleanup: 'PASS',
      scope: 'CONTRACT_AND_FIVE_ROLE_FOUNDATION_ORIGINAL_TEST_CONFIG',
      rows: r.checks,
    });
  }
  const result = reconcileLegalWrites(legal.operations, receipts);
  const missing = legal.missingPairs.map((m) => {
    const row = result.pairs.find((x) => x.operationId === m.operationId && x.role === m.role);
    return {
      ...m,
      historicalNeverRunClaimStillValid: !row.historicalHttpSuccess,
      currentlyVersionBoundHttpSuccess: row.currentlyVersionBoundHttpSuccess,
      requiresNotificationAuthorization: ['inviteUser', 'triggerUserPasswordReset'].includes(m.operationId),
      domainSuccessNotApplicable: m.operationId === 'retireDevice' && m.role === 'PlatformOperator',
      nextAction: row.currentlyVersionBoundHttpSuccess
        ? 'SCOPED_CURRENT_HTTP_AND_ACCOUNT_READBACK_COMPLETED'
        : row.historicalHttpSuccess
          ? 'HISTORICAL_SUCCESS_FOUND_REVALIDATE_IMPACTED_INPUTS'
          : m.reason,
    };
  });
  const summary = {
    ...result,
    task: 'QA09-CLOSE-01',
    gate: 'PASS_INVENTORY_ONLY_QA09_PARTIAL',
    targetCommit,
    comparisons,
    refs,
    originalMissingCandidates: missing,
    duplicatesRemovedFromNeverRun: missing.filter((m) => !m.historicalNeverRunClaimStillValid).length,
    semanticSupplement: freshSemantic,
    combinedHistoricalBehaviorCoverage: {
      everPass:
        semantic.counts.PASS +
        freshSemantic.filter((e) => semantic.elements.find((old) => old.id === e.id)?.result === 'NOT_RUN').length,
      neverRun:
        semantic.counts.NOT_RUN -
        freshSemantic.filter((e) => semantic.elements.find((old) => old.id === e.id)?.result === 'NOT_RUN').length,
      currentTargetVerified: freshSemantic.length,
      current117Accepted: false,
    },
    semantic: {
      sourceCommit: semantic.sourceCommit,
      counts: semantic.counts,
      compatibility: compatibility(semantic.sourceCommit),
      elements: semantic.elements.map((e) => ({
        id: e.id,
        group: e.group,
        result: e.result,
        reason: e.reason ?? null,
        currentAcceptance: 'NOT_TRANSFERRED',
      })),
    },
    qa09Gate: 'PARTIAL',
    releasePerformanceAccepted: false,
    productionReady: false,
  };
  // comparison() above may add the semantic source after the object was assembled (same shared object).
  writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, target, fresh] = process.argv.slice(2);
  if (!output || !target) throw Error('OUTPUT_AND_TARGET_COMMIT_REQUIRED');
  const r = collectBusinessReconciliation(output, target, fresh);
  console.log(
    JSON.stringify({
      gate: r.gate,
      pairs: r.candidatePairs,
      observed: r.historicallyObservedPairs,
      current: r.currentLiveVersionObservedPairs,
      duplicates: r.duplicatesRemovedFromNeverRun,
      fullQa09Accepted: false,
    }),
  );
}
