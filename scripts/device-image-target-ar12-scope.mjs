/** A single candidate-bound source exclusion, never a generic target-test waiver. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const AR12_DECISION = 'AR12-V1-MEDIA-OMISSION-NA-1';
export const AR12_SCOPE_DOC = 'docs/api/device-image-AR12-acceptance-scope.md';
export const AR12_LOCAL_RECEIPT =
  'docs/audit/evidence/2026-11-08-device-image-G3-rebind-preparation/local-regression.json';
export const AR12_LOCAL_REPORT = 'docs/audit/evidence/2026-11-08-device-image-G3-rebind-preparation/branch-vitest.json';
export const AR12_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export const AR12_SOURCE_FILES = [
  'packages/auth/src/roles.ts',
  'packages/auth/src/permissions.ts',
  'packages/auth/src/guard.ts',
  'packages/auth/src/cognito.ts',
  'apps/cloud-api/src/runtime/admin-lambda.ts',
  'apps/cloud-api/src/admin/alarm/evidence-query.ts',
  'apps/cloud-api/src/admin/alarm/service.ts',
  'apps/cloud-api/test/evidence-image-query.test.ts',
  'contracts/decisions/decision-register.json',
  'contracts/domain/role-mapping-policy.json',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
const check = (test, code) => {
  if (!test) throw new Error(code);
};
export function verifyAr12Scope({ candidate, readWorking, readCandidate }) {
  const scopeRead = (path) => {
    try {
      return readWorking(path);
    } catch {
      throw new Error('AR12_REQUIRED_SOURCE_OR_PROOF_MISSING');
    }
  };
  const committed = readCandidate(AR12_SOURCE_FILES);
  const sourceHashes = Object.fromEntries(
    AR12_SOURCE_FILES.map((path) => {
      check(hash(scopeRead(path)) === hash(committed[path]), 'AR12_SOURCE_SCOPE_DRIFT');
      return [path, hash(committed[path])];
    }),
  );
  const decisions = JSON.parse(committed['contracts/decisions/decision-register.json']);
  check(
    decisions.decisions.some((row) => row.id === 'DEC-012' && row.version === '1.0.0' && row.status === 'frozen'),
    'AR12_DECISION_DRIFT',
  );
  const localBytes = scopeRead(AR12_LOCAL_RECEIPT),
    local = JSON.parse(localBytes);
  check(
    local.formatVersion === 1 &&
      local.scope === 'LOCAL_PERMISSION_DENY_INJECTION_ONLY' &&
      local.sourceCommit === candidate &&
      local.exitCode === 0 &&
      same(local.sourceHashes, sourceHashes),
    'AR12_LOCAL_REGRESSION_BINDING',
  );
  check(local.report?.path === AR12_LOCAL_REPORT, 'AR12_LOCAL_REPORT_PATH');
  const reportBytes = scopeRead(AR12_LOCAL_REPORT);
  check(hash(reportBytes) === local.report.sha256, 'AR12_LOCAL_REPORT_HASH');
  const report = JSON.parse(reportBytes);
  check(
    report.success === true &&
      report.numFailedTests === 0 &&
      report.numPendingTests === 0 &&
      report.numPassedTests === 34 &&
      report.numTotalTests === 34 &&
      report.numFailedTestSuites === 0 &&
      report.numPendingTestSuites === 0 &&
      report.testResults?.length === 1,
    'AR12_LOCAL_REGRESSION_NOT_PASSED',
  );
  const suite = report.testResults[0];
  const expected = [
    ...['ALARM', 'EVENT'].map((kind) => `${kind} missing media:read omits the field and never queries images`),
    ...AR12_ROLES.map((role) => `${role} follows the current permission matrix`),
  ];
  check(
    suite.status === 'passed' &&
      suite.name.replaceAll('\\', '/').endsWith('/apps/cloud-api/test/evidence-image-query.test.ts') &&
      suite.assertionResults?.length === report.numPassedTests &&
      suite.assertionResults.every((row) => row.status === 'passed') &&
      expected.every(
        (title) => suite.assertionResults.filter((row) => row.title === title && row.status === 'passed').length === 1,
      ),
    'AR12_REQUIRED_LOCAL_CASES_MISSING',
  );
  const decision = {
    decisionId: AR12_DECISION,
    sourceCommit: candidate,
    caseId: 'AR12',
    variantId: 'no-media-permission',
    classification: 'NOT_APPLICABLE_SOURCE_BOUND',
    reasonCode: 'UNREACHABLE_FIXED_V1_ROLES',
    sourceHashes,
    roles: AR12_ROLES,
    decisionVersion: 'DEC-012@1.0.0',
    scopeDocument: { path: AR12_SCOPE_DOC, sha256: hash(scopeRead(AR12_SCOPE_DOC)) },
    localRegression: {
      scope: local.scope,
      receiptPath: AR12_LOCAL_RECEIPT,
      receiptSha256: hash(localBytes),
      reportPath: AR12_LOCAL_REPORT,
      reportSha256: hash(reportBytes),
      passedTests: report.numPassedTests,
      requiredTestTitles: expected,
    },
    gateEffect: 'EXCLUDE_ONLY_THIS_TARGET_VARIANT_NOT_THE_CASE',
    targetExecutionProven: false,
    invalidatedBy: [
      'candidate change',
      'source or permission change',
      'local regression failure or missing evidence',
      'scope/protocol digest change',
    ],
  };
  return { ...decision, policyDigest: hash(Buffer.from(JSON.stringify(decision))) };
}
export function ar12ExclusionRecord(scope) {
  return {
    caseId: 'AR12',
    variantId: 'no-media-permission',
    status: 'NOT_APPLICABLE',
    decisionId: AR12_DECISION,
    sourceCommit: scope.sourceCommit,
    policyDigest: scope.policyDigest,
    reasonCode: scope.reasonCode,
    targetExecuted: false,
    evidenceRefs: [],
  };
}
export function ar12VariantRecord(scope) {
  return {
    id: 'no-media-permission',
    status: 'NOT_APPLICABLE',
    decisionId: AR12_DECISION,
    policyDigest: scope.policyDigest,
    evidenceRefs: [],
  };
}
export function isAr12Exclusion(record, scope) {
  return same(record, ar12ExclusionRecord(scope));
}
export function isAr12Variant(record, scope) {
  return same(record, ar12VariantRecord(scope));
}
