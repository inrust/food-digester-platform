#!/usr/bin/env node
/** IMG-21 offline packaging and evidence inspection only. No AWS, HTTP, DB or credential client. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { subsetOpenApi } from './cloud-handoff-openapi.mjs';

import {
  verifyAr12Scope,
  ar12ExclusionRecord,
  ar12VariantRecord,
  isAr12Exclusion,
  isAr12Variant,
  AR12_LOCAL_RECEIPT,
  AR12_LOCAL_REPORT,
  AR12_SCOPE_DOC,
} from './device-image-target-ar12-scope.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CANDIDATE = 'd1a7b81196d60ec320e760da3d18de403563fc12';
export const PACKAGE = 'docs/api/fixtures/device-image-target';
export const G3 = 'docs/audit/evidence/2026-11-08-device-image-G3-rebind-d1a7b811';
export const G3_EVIDENCE_COMMIT = '1b1b879ffcf34be7cebd6fe87b8301ae5bd21356';
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const read = (path) => readFileSync(resolve(ROOT, path));
const parse = (path) => JSON.parse(read(path));
const fail = (code) => {
  throw new Error(code);
};
function safePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    /[\r\n\0\\]/u.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail('INVALID_RELATIVE_PATH');
  return path;
}
export function manifestRows(bytes) {
  const rows = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
      if (!match) fail('INVALID_HASH_MANIFEST');
      return { path: safePath(match[2]), sha256: match[1] };
    });
  if (new Set(rows.map((row) => row.path)).size !== rows.length) fail('DUPLICATE_HASH_PATH');
  return rows;
}
function readGitFiles(commit, paths) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) fail('INVALID_GIT_BINDING');
  paths.forEach(safePath);
  const run = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: paths.map((path) => `${commit}:${path}\n`).join(''),
    maxBuffer: 128 * 1024 * 1024,
  });
  if (run.status !== 0 || run.error) fail('CANDIDATE_GIT_READ_FAILED');
  const values = {};
  let offset = 0;
  for (const path of paths) {
    const end = run.stdout.indexOf(10, offset);
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(run.stdout.subarray(offset, end).toString());
    if (!match) fail('MISSING_CANDIDATE_BLOB');
    const size = Number(match[2]);
    offset = end + 1;
    values[path] = run.stdout.subarray(offset, offset + size);
    offset += size;
    if (values[path].length !== size || run.stdout[offset++] !== 10) fail('TRUNCATED_CANDIDATE_BLOB');
  }
  if (offset !== run.stdout.length) fail('UNEXPECTED_GIT_OUTPUT');
  return values;
}
export const PREPARATION_SOURCE_FILES = [
  'scripts/device-image-target-package.mjs',
  'scripts/device-image-target-package.test.mjs',
  'scripts/device-image-target-ar12-scope.mjs',
  'scripts/device-image-target-cases.json',
  'scripts/device-image-target-read-only.sql',
  'scripts/test-support/device-image-candidate-fixture.mjs',
  'docs/api/device-image-target-acceptance-guide.md',
  'docs/api/device-image-AR12-acceptance-scope.md',
];
export const isPreparationSource = (path) => PREPARATION_SOURCE_FILES.includes(path) || path.startsWith(`${PACKAGE}/`);
export const readCandidateFiles = (paths) => readGitFiles(CANDIDATE, paths);
export const readG3EvidenceFiles = (paths) => readGitFiles(G3_EVIDENCE_COMMIT, paths);
export function verifyG3() {
  const names = ['result.json', 'sources.sha256', 'artifacts.sha256', 'verification-sources.sha256'].map(
    (name) => `${G3}/${name}`,
  );
  const initial = readG3EvidenceFiles(names);
  const receipt = JSON.parse(initial[names[0]]);
  if (
    receipt.sourceCommit !== CANDIDATE ||
    receipt.gate?.status !== 'PASS_LOCAL' ||
    receipt.execution?.exitCode !== 0 ||
    receipt.fullVerifyStages?.length !== 22 ||
    receipt.fullVerifyStages.some((row) => row.status !== 'PASS') ||
    receipt.specializedReceipts?.length !== 7 ||
    receipt.specializedReceipts.some((row) => row.status !== 'PASS') ||
    JSON.stringify(receipt.specializedReceipts.map((row) => row.id)) !==
      JSON.stringify([
        'device-contracts',
        'iot-integration',
        'core-api-integration',
        'admin-e2e',
        'security',
        'reliability',
        'prototype-regression',
      ])
  )
    fail('G3_NOT_COMPLETE');
  const sources = manifestRows(initial[names[1]]);
  const artifacts = manifestRows(initial[names[2]]);
  const verified = manifestRows(initial[names[3]]);
  for (const [rows, bytes, binding] of [
    [sources, initial[names[1]], receipt.sourceManifest],
    [verified, initial[names[3]], receipt.verificationSourceManifest],
  ]) {
    if (rows.length !== binding?.fileCount || sha(bytes) !== binding.sha256) fail('G3_MANIFEST_BINDING_DRIFT');
  }
  // Complete verify inputs remain sealed against candidate Git objects. Only the
  // exact target-preparation protocol is independently versioned via protocolDigest.
  const expectedDelivery = verified.filter((row) => !isPreparationSource(row.path));
  const expectedPreparation = verified.filter((row) => isPreparationSource(row.path));
  if (
    JSON.stringify(sources) !== JSON.stringify(expectedDelivery) ||
    JSON.stringify(receipt.preparationProtocolInputs) !==
      JSON.stringify(expectedPreparation.map((row) => ({ path: row.path, candidateSha256: row.sha256 })))
  )
    fail('G3_SOURCE_SCOPE_DRIFT');
  const committed = readCandidateFiles(verified.map((row) => row.path));
  for (const row of verified) if (sha(committed[row.path]) !== row.sha256) fail('G3_COMMITTED_SOURCE_DRIFT');
  const commands = JSON.parse(committed['package.json']).scripts.verify.split(' && ');
  if (JSON.stringify(receipt.fullVerifyStages.map((row) => row.command)) !== JSON.stringify(commands))
    fail('G3_COMMAND_SCOPE_DRIFT');
  const evidence = readG3EvidenceFiles(artifacts.map((row) => row.path));
  for (const row of artifacts) if (sha(evidence[row.path]) !== row.sha256) fail('G3_COMMITTED_ARTIFACT_DRIFT');
  for (const row of receipt.specializedReceipts) {
    const bytes = evidence[row.path];
    const gate = bytes && JSON.parse(bytes);
    if (!bytes || sha(bytes) !== row.receiptSha256 || gate.status !== 'PASS' || gate.baselineCommit !== CANDIDATE)
      fail('G3_SPECIALIZED_RECEIPT_BINDING');
  }
  for (const row of sources) if (sha(read(row.path)) !== row.sha256) fail(`CURRENT_G3_SOURCE_DRIFT:${row.path}`);
  return {
    sourceCommit: CANDIDATE,
    evidenceCommit: G3_EVIDENCE_COMMIT,
    g3: 'PASS_LOCAL',
    g4: 'NOT_RUN',
    result: { path: names[0], sha256: sha(initial[names[0]]) },
    sources: { path: names[1], sha256: sha(initial[names[1]]), count: sources.length },
    artifacts: { path: names[2], sha256: sha(initial[names[2]]), count: artifacts.length },
    verificationSources: { path: names[3], sha256: sha(initial[names[3]]), count: verified.length },
    preparationScope: 'INDEPENDENT_PROTOCOL_DIGEST_AND_REGRESSION',
  };
}
export function protocolDigest() {
  return sha(
    json(
      Object.fromEntries(
        [
          ...PREPARATION_SOURCE_FILES,
          'scripts/device-image-target-ar12-scope.mjs',
          AR12_SCOPE_DOC,
          AR12_LOCAL_RECEIPT,
          AR12_LOCAL_REPORT,
          'scripts/device-image-target-cases.json',
          'scripts/device-image-target-read-only.sql',
          'scripts/cloud-handoff-openapi.mjs',
        ].map((path) => [path, sha(read(path))]),
      ),
    ),
  );
}
export const INPUTS = [
  ['accountId', '环境负责人', 'account'],
  ['region', '环境负责人', 'text'],
  ['stackName', '环境负责人', 'text'],
  ['adminBaseUrl', '环境负责人', 'url'],
  ['deviceBaseUrl', '环境负责人', 'url'],
  ['webOrigin', '环境负责人', 'origin'],
  ['mqttEndpoint', '环境负责人', 'text'],
  ['deployedCommit', '发布负责人', 'commit'],
  ['deploymentProof', '发布负责人', 'proof'],
  ['migrationProof', '数据库负责人', 'proof'],
  ['controlTable', '云端运维', 'text'],
  ['payloadTable', '云端运维', 'text'],
  ['archiveBucket', '云端运维', 'text'],
  ['runtimeVersionsProof', '云端运维', 'proof'],
  ['nativePgReadRef', '数据库负责人', 'ref'],
  ['deviceId', '环境负责人', 'text'],
  ['customerId', '环境负责人', 'text'],
  ['otherDeviceId', '环境负责人', 'text'],
  ['otherCustomerId', '环境负责人', 'text'],
  ['deviceMtlsRef', '身份负责人', 'ref'],
  ['otherDeviceMtlsRef', 'Identity owner for disposable device', 'ref'],
  ['mqttIdentityRef', '身份负责人', 'ref'],
  ['viewerARef', '身份负责人', 'ref'],
  ['viewerBRef', '身份负责人', 'ref'],
  ['rejectedIdentityRef', '身份负责人', 'ref'],
  ['otherTenantRef', '身份负责人', 'ref'],
  ['authorityWriterRef', '云端运维', 'ref'],
  ['testScopeProof', '验收执行负责人', 'proof'],
  ['executionWindowProof', '验收执行负责人', 'proof'],
  ['nativeWindow', '数据库/云端负责人', 'proof'],
  ['faultPlan', '云端运维', 'proof'],
  ['longWindow', '验收执行负责人', 'proof'],
  ['scaleAndSla', '业务/运营负责人', 'proof'],
  ['sequenceReservation', '设备接入负责人', 'proof'],
  ['cleanupPlan', '云端运维', 'proof'],
];
export function inputTemplate() {
  return {
    formatVersion: 1,
    sourceCommit: CANDIDATE,
    protocolDigest: protocolDigest(),
    mode: 'TARGET_CLOUD',
    entries: Object.fromEntries(INPUTS.map(([id, ownerRole, kind]) => [id, { ownerRole, kind, value: null }])),
  };
}
export function expectedMigrations() {
  return readdirSync(resolve(ROOT, 'packages/database/prisma/migrations'))
    .filter((name) => /^\d{14}_/u.test(name))
    .sort();
}
function proofDetailsValid(id, d, input) {
  if (!d || typeof d !== 'object') return false;
  const value = (key) => input.entries[key].value;
  const text = (v) => typeof v === 'string' && !!v.trim();
  const versionKeys = ['adminApi', 'deviceApi', 'ingestion', 'mediaEvidence', 'outbox'];
  switch (id) {
    case 'deploymentProof':
      return d.deployedSourceCommit === CANDIDATE && versionKeys.every((key) => text(d.versions?.[key]));
    case 'migrationProof':
      return (
        d.schemaSha256 === sha(read('packages/database/prisma/schema.prisma')) &&
        JSON.stringify(d.appliedMigrations) === JSON.stringify(expectedMigrations()) &&
        Array.isArray(d.pendingMigrations) &&
        d.pendingMigrations.length === 0
      );
    case 'runtimeVersionsProof':
      return (
        versionKeys.every((key) => text(d.versions?.[key])) &&
        d.LIVE_IMAGE_CONTROL_TABLE === value('controlTable') &&
        d.LIVE_IMAGE_PAYLOAD_TABLE === value('payloadTable') &&
        d.allAuthorityWritersOnCandidate === true
      );
    case 'testScopeProof':
      return (
        d.isolated === true &&
        d.mayMutate === true &&
        d.retirementAuthorized === true &&
        JSON.stringify(d.disposableDeviceIds) === JSON.stringify([value('otherDeviceId')]) &&
        JSON.stringify(d.deviceIds?.slice().sort()) ===
          JSON.stringify([value('deviceId'), value('otherDeviceId')].sort()) &&
        JSON.stringify(d.customerIds?.slice().sort()) ===
          JSON.stringify([value('customerId'), value('otherCustomerId')].sort())
      );
    case 'executionWindowProof':
      return (
        Number.isFinite(Date.parse(d.startsAt)) &&
        Date.parse(d.endsAt) > Date.parse(d.startsAt) &&
        d.permittedCloudCases === true
      );
    case 'nativeWindow':
      return (
        d.databaseEngine === 'POSTGRESQL_NATIVE' &&
        d.storageEngine === 'AWS_DYNAMODB' &&
        d.independentProcesses >= 2 &&
        d.independentPgConnections >= 2
      );
    case 'faultPlan':
      return (
        d.maxAffectedDevices === 2 &&
        d.restoreRequired === true &&
        text(d.rollbackPlan) &&
        JSON.stringify(d.caseIds?.slice().sort()) ===
          JSON.stringify(
            cases()
              .filter((row) => row.area === 'native')
              .map((row) => row.id)
              .sort(),
          )
      );
    case 'longWindow':
      return d.targetClockUnmodified === true && Date.parse(d.endsAt) - Date.parse(d.startsAt) >= 86400000;
    case 'scaleAndSla':
      return (
        Number.isSafeInteger(d.enabledDevices) &&
        d.enabledDevices > 0 &&
        Number.isSafeInteger(d.concurrentViewersPerDevice) &&
        d.concurrentViewersPerDevice > 0 &&
        d.concurrentViewersPerDevice <= 16 &&
        Number.isSafeInteger(d.firstFrameTargetMs) &&
        d.firstFrameTargetMs > 0 &&
        text(d.networkProfile)
      );
    case 'sequenceReservation':
      return (
        d.deviceId === value('deviceId') &&
        d.exclusive === true &&
        d.originalCounterRecorded === true &&
        Number.isSafeInteger(d.firstSeq) &&
        d.firstSeq > 0 &&
        Number.isSafeInteger(d.lastSeq) &&
        d.lastSeq - d.firstSeq >= 5 &&
        d.lastSeq <= 2147483647
      );
    case 'cleanupPlan':
      return (
        d.usesResourceLedger === true &&
        d.disableThroughAuthorityWriter === true &&
        d.preserveControlEpoch === true &&
        d.preserveHistoricalLinks === true &&
        d.deleteOnlyOwnedKeys === true &&
        text(d.retentionDecision)
      );
    default:
      return false;
  }
}
export function ar12Scope(readWorking = read, readCandidate = readCandidateFiles) {
  return verifyAr12Scope({ candidate: CANDIDATE, readWorking, readCandidate });
}
export function admission(input, readArtifact = () => fail('ARTIFACT_READER_REQUIRED'), scopeProvider = ar12Scope) {
  const errors = [],
    blocked = [];
  try {
    assertRedacted(input);
  } catch {
    errors.push('SENSITIVE_INPUT');
  }
  if (
    input?.protocolDigest !== protocolDigest() ||
    input?.formatVersion !== 1 ||
    input?.sourceCommit !== CANDIDATE ||
    input?.mode !== 'TARGET_CLOUD'
  )
    errors.push('INVALID_INPUT_BINDING');
  if (
    !input?.entries ||
    Object.keys(input.entries).sort().join() !==
      INPUTS.map((row) => row[0])
        .sort()
        .join()
  )
    errors.push('INPUT_INVENTORY_DRIFT');
  for (const [id, owner, kind] of INPUTS) {
    const entry = input?.entries?.[id];
    const value = entry?.value;
    if (!entry || entry.kind !== kind || entry.ownerRole !== owner) {
      errors.push(`INPUT_DEFINITION_DRIFT:${id}`);
      continue;
    }
    if (value === null) {
      blocked.push({ id, ownerRole: owner, reason: 'MISSING_TARGET_INPUT' });
      continue;
    }
    if (kind === 'proof') {
      try {
        if (!value || Object.keys(value).sort().join() !== 'path,sha256' || !/^[a-f0-9]{64}$/u.test(value.sha256))
          fail('INVALID_PROOF');
        const bytes = readArtifact(safePath(value.path));
        if (sha(bytes) !== value.sha256) fail('PROOF_HASH_MISMATCH');
        const proof = JSON.parse(bytes);
        assertRedacted(proof);
        if (
          proof.mode !== 'TARGET_CLOUD' ||
          proof.syntheticResponsesAllowed !== false ||
          proof.sourceCommit !== CANDIDATE ||
          proof.inputId !== id ||
          proof.accountId !== input.entries.accountId.value ||
          proof.region !== input.entries.region.value ||
          proof.stackName !== input.entries.stackName.value ||
          proof.passed !== true ||
          !proofDetailsValid(id, proof.details, input)
        )
          fail('PROOF_SCOPE_MISMATCH');
      } catch {
        errors.push(`INVALID_TARGET_PROOF:${id}`);
      }
    } else {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        /[\r\n]/u.test(value) ||
        /example|placeholder|<|>|\{\{|\.invalid/iu.test(value)
      ) {
        errors.push(`INVALID_INPUT:${id}`);
        continue;
      }
      if (kind === 'account' && !/^[0-9]{12}$/u.test(value)) errors.push(`INVALID_ACCOUNT:${id}`);
      if (kind === 'commit' && value !== CANDIDATE) errors.push('DEPLOYED_CANDIDATE_MISMATCH');
      if (kind === 'ref' && !/^ref:[A-Za-z0-9/_:.-]+$/u.test(value)) errors.push(`INVALID_REFERENCE:${id}`);
      if (kind === 'url' || kind === 'origin') {
        try {
          const url = new URL(value);
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (kind === 'origin' && url.origin !== value)
          )
            fail('INVALID_URL');
        } catch {
          errors.push(`INVALID_HTTPS_ENDPOINT:${id}`);
        }
      }
    }
  }
  for (const [a, b] of [
    ['deviceId', 'otherDeviceId'],
    ['customerId', 'otherCustomerId'],
    ['viewerARef', 'viewerBRef'],
  ])
    if (input?.entries?.[a]?.value && input.entries[a].value === input.entries[b]?.value)
      errors.push(`IDENTITIES_NOT_DISTINCT:${a}:${b}`);
  try {
    scopeProvider();
  } catch {
    blocked.push({
      id: 'ar12ScopeRevalidationRequired',
      ownerRole: 'Cloud acceptance and RBAC owner',
      reason: 'AR12_SOURCE_OR_LOCAL_REGRESSION_INVALID',
    });
  }
  return {
    status: errors.length ? 'FAIL' : blocked.length ? 'BLOCKED' : 'PASS_INPUT_STRUCTURE_ONLY',
    errors,
    blocked,
    cloudRequests: 0,
  };
}
export function assertRedacted(value) {
  const visit = (node, key = '') => {
    if (node === null || node === '[REDACTED]') return;
    if (
      /^(authorization|cookie|password|privateKey|accessToken|idToken|refreshToken|secretAccessKey|accessKeyId|awsSessionToken|secret|token|credentials?|imageBase64|signedUrl|uploadUrl|downloadUrl)$/iu.test(
        key,
      )
    )
      fail('SENSITIVE_ARTIFACT');
    if (
      typeof node === 'string' &&
      (/-----BEGIN [A-Z ]*PRIVATE KEY/u.test(node) ||
        /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(node) ||
        /\beyJ[\w-]+\.[\w-]+\.[\w-]+/u.test(node) ||
        /X-Amz-(Signature|Credential|Security-Token)=/iu.test(node))
    )
      fail('SENSITIVE_ARTIFACT');
    if (node && typeof node === 'object') Object.entries(node).forEach(([k, v]) => visit(v, k));
  };
  visit(value);
}
export function cases() {
  return parse('scripts/device-image-target-cases.json').cases;
}
export function validateCases(rows = cases()) {
  const operations = new Set(
    Object.values(parse('contracts/rest/openapi.bundle.json').paths)
      .flatMap((methods) => Object.values(methods).map((op) => op.operationId))
      .filter(Boolean),
  );
  const seen = new Set();
  for (const row of rows) {
    if (
      seen.has(row.id) ||
      !row.steps?.length ||
      !row.assertions?.length ||
      !row.evidenceKinds?.length ||
      row.status !== 'NOT_RUN' ||
      row.operations.some((id) => !operations.has(id)) ||
      row.dependsOn.some((id) => !seen.has(id))
    )
      fail('INVALID_CASE_CATALOG');
    seen.add(row.id);
  }
  if (rows.length !== 44 || !['PV14', 'AR14', 'NC12', 'OP04'].every((id) => seen.has(id)))
    fail('INCOMPLETE_CASE_CATALOG');
  const ar12 = rows.find((row) => row.id === 'AR12');
  const variants = ['allowed', 'no-media-permission', 'cross-tenant', 'unassociated', 'deleted', 'download-failure'];
  if (
    !ar12 ||
    ar12.requiredVariants?.length !== 6 ||
    new Set(ar12.requiredVariants).size !== 6 ||
    variants.some((id) => !ar12.requiredVariants.includes(id)) ||
    ar12.evidenceKinds?.length !== 3 ||
    ['HTTP', 'DB', 'S3'].some((kind) => !ar12.evidenceKinds.includes(kind)) ||
    ar12.assertions?.length !== 3 ||
    ['AR12-A1', 'AR12-A2', 'AR12-A3'].some((id) => !ar12.assertions.some((a) => a.id === id))
  )
    fail('AR12_TARGET_SCOPE_REDUCED');
  return rows;
}
export function receiptTemplate() {
  return {
    formatVersion: 1,
    sourceCommit: CANDIDATE,
    protocolDigest: protocolDigest(),
    mode: 'TARGET_CLOUD',
    syntheticResponsesAllowed: false,
    runId: null,
    startedAt: null,
    finishedAt: null,
    environment: { accountId: null, region: null, stackName: null },
    execution: 'NOT_RUN',
    g4: 'NOT_RUN',
    cases: cases().map((row) => ({
      id: row.id,
      status: 'NOT_RUN',
      assertions: [],
      evidenceRefs: [],
      variants: row.requiredVariants.map((id) =>
        row.id === 'AR12' && id === 'no-media-permission'
          ? ar12VariantRecord(ar12Scope())
          : { id, status: 'NOT_RUN', evidenceRefs: [] },
      ),
    })),
    artifacts: [],
    sourceExclusions: [ar12ExclusionRecord(ar12Scope())],
    cleanup: { status: 'NOT_RUN', ledgerRef: null },
  };
}
export function validateReceipt(receipt, input, readArtifact, scopeProvider = ar12Scope) {
  const errors = [],
    pending = [];
  const planned = validateCases();
  let scope;
  try {
    scope = scopeProvider();
  } catch {
    return {
      status: 'BLOCKED',
      g4: 'NOT_RUN',
      errors: [],
      blocked: [{ id: 'ar12ScopeRevalidationRequired', reason: 'AR12_SOURCE_OR_LOCAL_REGRESSION_INVALID' }],
      cloudRequests: 0,
    };
  }
  if (
    !Array.isArray(receipt?.sourceExclusions) ||
    receipt.sourceExclusions.length !== 1 ||
    !isAr12Exclusion(receipt.sourceExclusions[0], scope)
  )
    errors.push('AR12_SOURCE_EXCLUSION_INVALID');

  if (
    receipt?.protocolDigest !== protocolDigest() ||
    receipt?.formatVersion !== 1 ||
    receipt?.sourceCommit !== CANDIDATE ||
    receipt?.mode !== 'TARGET_CLOUD' ||
    receipt?.syntheticResponsesAllowed !== false
  )
    errors.push('INVALID_TARGET_RECEIPT_BINDING');
  if (receipt?.g4 !== 'NOT_RUN') errors.push('OFFLINE_VALIDATOR_CANNOT_PROMOTE_G4');
  const rows = receipt?.cases;
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        !Array.isArray(row.assertions) ||
        !Array.isArray(row.evidenceRefs) ||
        !Array.isArray(row.variants),
    ) ||
    !Array.isArray(receipt?.artifacts)
  )
    return { status: 'FAIL', g4: 'NOT_RUN', errors: ['MALFORMED_RECEIPT'], cloudRequests: 0 };
  if (
    !Array.isArray(rows) ||
    rows.length !== planned.length ||
    new Set(rows.map((row) => row.id)).size !== planned.length ||
    planned.some((row) => !rows.some((r) => r.id === row.id))
  )
    errors.push('CASE_INVENTORY_DRIFT');
  const declared = receipt?.artifacts ?? [];
  const refs = new Map();
  for (const row of declared) {
    try {
      if (!row?.id || refs.has(row.id) || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('INVALID_ARTIFACT');
      const bytes = readArtifact(safePath(row.path));
      if (sha(bytes) !== row.sha256) fail('ARTIFACT_HASH_MISMATCH');
      const artifact = JSON.parse(bytes);
      assertRedacted(artifact);
      if (
        artifact.mode !== 'TARGET_CLOUD' ||
        artifact.syntheticResponsesAllowed !== false ||
        artifact.sourceCommit !== CANDIDATE ||
        artifact.runId !== receipt.runId ||
        !artifact.caseId ||
        !artifact.kind ||
        artifact.accountId !== receipt.environment.accountId ||
        artifact.region !== receipt.environment.region ||
        artifact.stackName !== receipt.environment.stackName ||
        !Number.isFinite(Date.parse(artifact.capturedAt)) ||
        Date.parse(artifact.capturedAt) < Date.parse(receipt.startedAt) ||
        Date.parse(artifact.capturedAt) > Date.parse(receipt.finishedAt)
      )
        fail('ARTIFACT_SCOPE_MISMATCH');
      if (
        (artifact.kind === 'DB' && artifact.engine !== 'POSTGRESQL_NATIVE') ||
        (artifact.kind === 'DDB' && artifact.engine !== 'AWS_DYNAMODB')
      )
        fail('LOCAL_STORAGE_CANNOT_PROVE_TARGET');
      if (artifact.caseId === 'AR12' && artifact.variantId === 'no-media-permission')
        fail('N_A_CANNOT_HAVE_TARGET_ARTIFACT');
      refs.set(row.id, artifact);
    } catch {
      errors.push(`INVALID_TARGET_ARTIFACT:${row?.id ?? 'missing'}`);
    }
  }
  for (const row of rows ?? []) {
    const plan = planned.find((p) => p.id === row.id);
    if (!plan) continue;
    if (!['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(row.status)) errors.push(`INVALID_CASE_STATUS:${row.id}`);
    const allVariants = row.variants;
    if (
      allVariants.length !== plan.requiredVariants.length ||
      new Set(allVariants.map((v) => v?.id)).size !== allVariants.length ||
      plan.requiredVariants.some((id) => !allVariants.some((v) => v?.id === id))
    )
      errors.push(`VARIANT_INVENTORY:${row.id}`);
    for (const variant of allVariants) {
      const excluded = row.id === 'AR12' && variant?.id === 'no-media-permission';
      if (excluded ? !isAr12Variant(variant, scope) : !['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(variant?.status))
        errors.push(`INVALID_VARIANT_STATUS:${row.id}`);
      if (!excluded && variant?.status === 'FAIL') errors.push(`CASE_VARIANT_FAILED:${row.id}:${variant.id}`);
    }
    if (row.status === 'FAIL') errors.push(`CASE_FAILED:${row.id}`);
    else if (row.status !== 'PASS') {
      pending.push({
        id: row.id,
        status: row.status === 'NOT_RUN' && allVariants.some((v) => v?.status === 'BLOCKED') ? 'BLOCKED' : row.status,
      });
      continue;
    }
    const variants = row.variants ?? [];
    if (
      variants.length !== plan.requiredVariants.length ||
      new Set(variants.map((v) => v.id)).size !== variants.length ||
      plan.requiredVariants.some(
        (id) =>
          !(row.id === 'AR12' && id === 'no-media-permission' && variants.some((v) => isAr12Variant(v, scope))) &&
          !variants.some(
            (v) =>
              v.id === id &&
              v.status === 'PASS' &&
              v.evidenceRefs?.length &&
              v.evidenceRefs.every((ref) => refs.get(ref)?.caseId === row.id && refs.get(ref)?.variantId === id),
          ),
      )
    )
      errors.push(`VARIANT_COVERAGE:${row.id}`);
    const assertions = row.assertions ?? [];
    if (
      assertions.length !== plan.assertions.length ||
      new Set(assertions.map((a) => a.id)).size !== plan.assertions.length ||
      plan.assertions.some((a) => !assertions.some((v) => v.id === a.id && v.passed === true))
    )
      errors.push(`ASSERTION_COVERAGE:${row.id}`);
    const evidence = (row.evidenceRefs ?? []).map((id) => refs.get(id));
    if (
      new Set(row.evidenceRefs ?? []).size !== (row.evidenceRefs ?? []).length ||
      evidence.some((e) => !e || e.caseId !== row.id) ||
      plan.evidenceKinds.some((kind) => !evidence.some((e) => e?.kind === kind))
    )
      errors.push(`EVIDENCE_COVERAGE:${row.id}`);
  }
  if (receipt?.execution === 'NOT_RUN' && rows.some((row) => row.status !== 'NOT_RUN'))
    errors.push('UNEXECUTED_CASE_CLAIM');
  if (receipt?.execution === 'NOT_RUN' || pending.length)
    return {
      status: errors.length ? 'FAIL' : pending.some((row) => row.status === 'BLOCKED') ? 'BLOCKED' : 'NOT_RUN',
      g4: 'NOT_RUN',
      errors,
      pending,
      cloudRequests: 0,
    };
  const ready = admission(input, readArtifact, scopeProvider);
  if (!ready.errors.length && !ready.blocked.some((row) => row.reason === 'MISSING_TARGET_INPUT')) {
    const window = JSON.parse(readArtifact(input.entries.executionWindowProof.value.path)).details;
    if (
      Date.parse(receipt.startedAt) < Date.parse(window.startsAt) ||
      Date.parse(receipt.finishedAt) > Date.parse(window.endsAt)
    )
      errors.push('OUTSIDE_AUTHORIZED_WINDOW');
    if (Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt) < 86400000)
      errors.push('REAL_24H_WINDOW_NOT_PROVEN');
  }
  errors.push(...ready.errors);
  if (
    !/^IMG21-[A-Za-z0-9-]{8,64}$/u.test(receipt.runId ?? '') ||
    receipt.execution !== 'EXECUTED' ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !(Date.parse(receipt.finishedAt) > Date.parse(receipt.startedAt))
  )
    errors.push('INVALID_EXECUTION_WINDOW');
  for (const key of ['accountId', 'region', 'stackName'])
    if (receipt.environment?.[key] !== input?.entries?.[key]?.value) errors.push('RECEIPT_ENVIRONMENT_DRIFT');
  const cleanup = refs.get(receipt?.cleanup?.ledgerRef);
  if (receipt?.cleanup?.status !== 'PASS' || cleanup?.kind !== 'CLEANUP' || cleanup?.caseId !== 'OP03')
    errors.push('CLEANUP_NOT_PROVEN');
  const ledger = cleanup?.data;
  if (
    !ledger?.entries?.length ||
    ledger.postChecks?.activeTestViewerCount !== 0 ||
    ledger.postChecks?.faultConfigurationRestored !== true ||
    ledger.postChecks?.historicalLinksPreserved !== true ||
    ledger.entries.some(
      (row) =>
        !row.id ||
        row.ownerRunId !== receipt.runId ||
        ![input?.entries?.deviceId?.value, input?.entries?.otherDeviceId?.value].includes(row.deviceId) ||
        !['RELEASED', 'RESTORED', 'RETAINED', 'REMOVED'].includes(row.disposition) ||
        (row.resourceType === 'DDB_CONTROL' && row.disposition === 'REMOVED'),
    )
  )
    errors.push('CLEANUP_LEDGER_INVALID');

  return {
    status: errors.length ? 'FAIL' : ready.blocked.length ? 'BLOCKED' : 'PASS_STRUCTURE_ONLY',
    g4: 'NOT_RUN',
    requiresRealExecutionReview: true,
    errors,
    blocked: ready.blocked,
    cloudRequests: 0,
  };
}
export function buildPackage() {
  const binding = verifyG3();
  const catalog = validateCases();
  const api = parse('contracts/rest/openapi.bundle.json');
  const ids = [...new Set(catalog.flatMap((row) => row.operations))];
  const paths = Object.keys(api.paths).filter((path) =>
    Object.values(api.paths[path]).some((op) => ids.includes(op.operationId)),
  );
  // The shared handoff resolver intentionally accepts schemas/responses only. Inline
  // bundled parameter aliases here without changing the frozen shared generator.
  const inlineParameters = (value) => {
    if (Array.isArray(value)) return value.map(inlineParameters);
    if (!value || typeof value !== 'object') return value;
    if (value.$ref?.startsWith('#/components/parameters/')) {
      const name = value.$ref.slice('#/components/parameters/'.length);
      if (!api.components.parameters?.[name]) fail('MISSING_BUNDLED_PARAMETER');
      return inlineParameters({
        ...api.components.parameters[name],
        ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')),
      });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineParameters(item)]));
  };
  const subset = subsetOpenApi({
    document: inlineParameters(api),
    documents: {},
    paths,
    securitySchemes: ['DeviceMtls', 'CognitoJwt'],
  });
  const output = {
    'candidate.json': json({
      ...binding,
      preparation: 'OFFLINE_ONLY',
      sixRequirements: [
        'candidate-and-G3',
        'environment-and-identity',
        'five-preview-operations',
        'event-alarm-S3',
        'native-concurrency-authority-recovery',
        'execution-cleanup-G4',
      ],
      policy: parse('contracts/domain/camera-interaction-policy.json').liveImage,
    }),
    'inputs.template.json': json(inputTemplate()),
    'cases.json': json({ formatVersion: 1, cases: catalog }),
    'receipt.template.json': json(receiptTemplate()),
    'reachability.json': json({
      sourceCommit: CANDIDATE,
      blockers: [],
      sourceExclusions: [ar12Scope()],
      note: 'Only AR12/no-media-permission is source-bound NOT_APPLICABLE. Other target checks remain mandatory. Local denial regression is not target evidence.',
    }),
    'resources.template.json': json({
      sourceCommit: CANDIDATE,
      runId: null,
      entries: [],
      postChecks: { activeTestViewerCount: null, faultConfigurationRestored: null, historicalLinksPreserved: null },
      note: 'Record owned IDs/keys and baseline digests before mutation; never store credentials or image bodies.',
    }),
    'openapi.json': json({
      openapi: '3.1.0',
      info: {
        title: 'IMG-21 cloud target acceptance subset',
        version: parse('contracts/contract-version.json').contractVersion,
      },
      servers: [{ url: 'https://target.example.invalid' }],
      ...subset,
    }),
    'capture.jpg': read('contracts/rest/fixtures/device-images/capture.jpg'),
    'frame-request.template.json': json({
      ...parse('contracts/rest/fixtures/device-images/frame-request.json'),
      streamId: '{{CURRENT_STREAM_ID}}',
      frameId: '{{NEW_FRAME_UUID}}',
      capturedAt: '{{CAPTURED_AT_UTC}}',
    }),
    'requests.json': json({
      executable: false,
      note: 'Resolve route parameters and current response identifiers at execution time. No credentials embedded.',
      operations: paths.flatMap((path) =>
        Object.entries(api.paths[path])
          .filter(([, op]) => ids.includes(op.operationId))
          .map(([method, op]) => ({
            operationId: op.operationId,
            method: method.toUpperCase(),
            path,
            security: op.security,
            body: op.requestBody ? 'JSON_FROM_FROZEN_SCHEMA' : 'NONE',
            declaredStatuses: Object.keys(op.responses),
          })),
      ),
    }),
    'read-only-probes.sql': read('scripts/device-image-target-read-only.sql'),
  };
  const inputs = [
    'scripts/device-image-target-package.mjs',
    'scripts/device-image-target-package.test.mjs',
    'scripts/test-support/device-image-candidate-fixture.mjs',
    'scripts/device-image-target-ar12-scope.mjs',
    AR12_SCOPE_DOC,
    AR12_LOCAL_RECEIPT,
    AR12_LOCAL_REPORT,
    'scripts/device-image-target-cases.json',
    'scripts/device-image-target-read-only.sql',
    'scripts/cloud-handoff-openapi.mjs',
    'docs/api/device-image-target-acceptance-guide.md',
    'contracts/rest/openapi.bundle.json',
    'contracts/domain/camera-interaction-policy.json',
    'contracts/media/media-upload-policy.json',
    'docs/api/fixtures/device-preview/manifest.json',
    'docs/api/fixtures/device-archive/manifest.json',
  ];
  output['manifest.json'] = json({
    formatVersion: 1,
    sourceCommit: CANDIDATE,
    cloudRequests: 0,
    files: Object.fromEntries(Object.entries(output).map(([name, bytes]) => [name, sha(bytes)])),
    inputs: Object.fromEntries(inputs.map((path) => [path, sha(read(path))])),
  });
  return output;
}
export function writeOrCheck(check) {
  const output = buildPackage();
  const dir = resolve(ROOT, PACKAGE);
  mkdirSync(dir, { recursive: true });
  if (check && readdirSync(dir).sort().join() !== Object.keys(output).sort().join())
    fail('PACKAGE_FILE_INVENTORY_DRIFT');
  for (const [name, bytes] of Object.entries(output)) {
    if (check) {
      if (!readFileSync(resolve(dir, name)).equals(bytes)) fail(`STALE_TARGET_PACKAGE:${name}`);
    } else writeFileSync(resolve(dir, name), bytes);
  }
  return {
    status: 'PASS_OFFLINE_PACKAGE',
    files: Object.keys(output).length,
    cases: cases().length,
    g3: `PASS_LOCAL_BOUND_TO_${CANDIDATE.slice(0, 8)}`,
    g4: 'NOT_RUN',
    cloudRequests: 0,
  };
}
export function artifactReader(directory) {
  const base = realpathSync(directory);
  return (path) => {
    const file = realpathSync(resolve(base, safePath(path)));
    if (!file.startsWith(base + '/')) fail('ARTIFACT_OUTSIDE_RUN_DIRECTORY');
    return readFileSync(file);
  };
}
export function main(args) {
  if (args.length === 1 && ['--generate', '--check'].includes(args[0])) return writeOrCheck(args[0] === '--check');
  if (args.length === 2 && args[0] === '--admission') {
    const file = resolve(args[1]);
    return admission(JSON.parse(readFileSync(file)), artifactReader(dirname(file)));
  }
  if (args.length === 3 && args[0] === '--receipt') {
    const receipt = resolve(args[1]),
      input = resolve(args[2]);
    return validateReceipt(
      JSON.parse(readFileSync(receipt)),
      JSON.parse(readFileSync(input)),
      artifactReader(dirname(receipt)),
    );
  }
  fail(
    'USAGE: --generate | --check | --admission <inputs.json> | --receipt <receipt.json> <inputs.json>; offline only',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (['FAIL', 'BLOCKED', 'NOT_RUN'].includes(result.status)) process.exitCode = result.status === 'FAIL' ? 1 : 2;
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  }
}
