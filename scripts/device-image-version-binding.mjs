/** MC03 pure/offline source and version acceptance. No AWS/HTTP/DB client or automatic approval. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const APP = 'd1a7b81196d60ec320e760da3d18de403563fc12';
export const TOOLS = '4a99ce1e86717897200fb3315067e98d907045a7';
export const EVIDENCE = 'docs/audit/evidence/2026-11-09-device-image-MC03';
export const BUILD_INPUTS = [
  'apps',
  'packages',
  'contracts',
  'infra',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/esgiot-cdk.mjs',
];
export const hash = (b) => createHash('sha256').update(b).digest('hex');
export const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
export const digest = (v) => hash(canonical(v));
export const need = (ok, code) => {
  if (!ok) throw Error(code);
};
const commit = (s) => typeof s === 'string' && /^[a-f0-9]{40}$/u.test(s);
const sha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
const iso = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
export function relativePath(p) {
  need(
    typeof p === 'string' &&
      p &&
      !p.startsWith('/') &&
      !/[\r\n\0\\]/u.test(p) &&
      p.split('/').every((s) => s && s !== '.' && s !== '..'),
    'INVALID_BINDING_PATH',
  );
  return p;
}
export function git(args, input) {
  const r = spawnSync('git', args, { cwd: ROOT, input, maxBuffer: 128 * 1024 * 1024 });
  need(r.status === 0 && !r.error, 'IMMUTABLE_GIT_READ_FAILED');
  return r.stdout;
}
export function gitFiles(sha1, paths) {
  need(commit(sha1), 'INVALID_SOURCE_COMMIT');
  const out = Object.create(null);
  for (let offset = 0; offset < paths.length; offset += 64) {
    const part = paths.slice(offset, offset + 64);
    part.forEach(relativePath);
    const raw = git(['cat-file', '--batch'], Buffer.from(part.map((p) => `${sha1}:${p}\n`).join('')));
    let cursor = 0;
    for (const p of part) {
      const end = raw.indexOf(10, cursor),
        m = /^[a-f0-9]{40} blob (\d+)$/u.exec(raw.subarray(cursor, end).toString());
      need(m, 'MISSING_FROZEN_BLOB');
      cursor = end + 1;
      out[p] = raw.subarray(cursor, cursor + Number(m[1]));
      cursor += Number(m[1]);
      need(raw[cursor++] === 10, 'CORRUPT_GIT_BATCH');
    }
    need(cursor === raw.length, 'CORRUPT_GIT_TRAILER');
  }
  return out;
}
export function gitInventory(c) {
  need(commit(c), 'INVALID_SOURCE_COMMIT');
  return git(['ls-tree', '-rz', '--full-tree', c])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const m = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/su.exec(row);
      need(m, 'UNSUPPORTED_CANDIDATE_OBJECT');
      return { path: m[3], mode: m[1], blob: m[2] };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function sourceSnapshot(c) {
  const inventory = gitInventory(c),
    paths = inventory.filter((r) => !r.path.startsWith('docs/')).map((r) => r.path);
  const blobs = gitFiles(c, paths);
  return {
    candidate: c,
    tree: git(['rev-parse', c + '^{tree}'])
      .toString()
      .trim(),
    inventory,
    inventoryDigest: digest(inventory),
    sources: paths.map((path) => ({ path, sha256: hash(blobs[path]) })),
  };
}
export function verifySnapshot(s) {
  need(commit(s.candidate) && sha(s.inventoryDigest), 'INVALID_SOURCE_SNAPSHOT');
  need(
    digest(gitInventory(s.candidate)) === s.inventoryDigest && digest(s.inventory) === s.inventoryDigest,
    'FROZEN_INVENTORY_DRIFT',
  );
  need(
    git(['rev-parse', s.candidate + '^{tree}'])
      .toString()
      .trim() === s.tree,
    'FROZEN_TREE_DRIFT',
  );
  const expected = s.inventory.filter((r) => !r.path.startsWith('docs/')).map((r) => r.path);
  need(canonical(s.sources.map((r) => r.path)) === canonical(expected), 'SOURCE_SCOPE_NARROWED');
  const blobs = gitFiles(s.candidate, expected);
  for (const r of s.sources)
    need(
      hash(blobs[r.path]) === r.sha256 && hash(readFileSync(resolve(ROOT, r.path))) === r.sha256,
      'CURRENT_FROZEN_SOURCE_DRIFT:' + r.path,
    );
  const changes = git(['diff', '--name-only', '-z', s.candidate, 'HEAD']).toString().split('\0').filter(Boolean);
  const unstaged = git(['diff', '--name-only', '-z', 'HEAD']).toString().split('\0').filter(Boolean);
  const extra = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  for (const path of [...changes, ...unstaged, ...extra])
    need(path.startsWith(EVIDENCE + '/'), 'NON_EVIDENCE_CHANGE_REQUIRES_REBIND:' + path);
  return true;
}
export function refBytes(ref, read) {
  need(ref && Object.keys(ref).sort().join() === 'path,sha256' && sha(ref.sha256), 'INVALID_BINDING_REFERENCE');
  const b = read(relativePath(ref.path));
  need(hash(b) === ref.sha256, 'BINDING_ARTIFACT_HASH_DRIFT:' + ref.path);
  return b;
}
export const refJson = (ref, read) => JSON.parse(refBytes(ref, read));
const blobsForLock = (c) => gitFiles(c, ['pnpm-lock.yaml'])['pnpm-lock.yaml'];
export function verifyCatalog(c, read, { requireCommitted = true } = {}) {
  need(
    c?.formatVersion === 2 &&
      c.applicationCandidate === APP &&
      c.executionToolsSourceCommit === TOOLS &&
      commit(c.repositoryCandidate) &&
      c.protocolSourceCommit === c.repositoryCandidate,
    'CATALOG_IDENTITY_DRIFT',
  );
  const s = refJson(c.repositorySnapshot, read);
  need(s.candidate === c.repositoryCandidate, 'SOURCE_CANDIDATE_MISMATCH');
  verifySnapshot(s);
  need(
    git(['rev-parse', `${c.repositoryCandidate}:tools/img21`]).equals(git(['rev-parse', `${TOOLS}:tools/img21`])),
    'TOOLS_SOURCE_TREE_DRIFT',
  );
  for (const p of BUILD_INPUTS)
    need(
      git(['rev-parse', `${APP}:${p}`]).equals(git(['rev-parse', `${c.repositoryCandidate}:${p}`])),
      'APPLICATION_BUILD_INPUT_DRIFT:' + p,
    );
  const expectedPaths = s.sources.filter(
    (r) =>
      r.path.startsWith('tools/img21/') ||
      [
        '.npmrc',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.base.json',
        'vitest.config.mjs',
        'eslint.config.mjs',
        'infra/src/database-capacity.ts',
      ].includes(r.path),
  );
  need(canonical(c.toolSources) === canonical(expectedPaths), 'INDEPENDENT_TOOLS_SCOPE_DRIFT');
  need(
    canonical(c.executionTools.map((t) => [t.id, t.entry, t.authorityWriter])) ===
      canonical([
        ['writer', 'tools/img21/writer-entry.ts', true],
        ['verifier', 'tools/img21/verifier-entry.ts', false],
      ]),
    'EXECUTION_TOOLS_INVENTORY_DRIFT',
  );
  const quality = refJson(c.quality, read);
  need(
    quality.repositoryCandidate === c.repositoryCandidate &&
      quality.snapshotDigest === hash(refBytes(c.repositorySnapshot, read)) &&
      quality.status === 'PASS_LOCAL' &&
      quality.fullVerifyStages.length === 22 &&
      quality.fullVerifyStages.every((r) => r.status === 'PASS' && r.exitCode === 0),
    'QUALITY_NOT_COMPLETE',
  );
  const scripts = JSON.parse(gitFiles(c.repositoryCandidate, ['package.json'])['package.json']).scripts.verify.split(
    ' && ',
  );
  need(canonical(quality.fullVerifyStages.map((r) => r.command)) === canonical(scripts), 'VERIFY_COMMAND_SCOPE_DRIFT');
  for (const row of [...quality.fullVerifyStages, ...quality.independentChecks]) {
    need(row.status === 'PASS' && row.exitCode === 0, 'INDEPENDENT_CHECK_NOT_COMPLETE');
    refBytes(row.log, read);
  }
  const independent = [
    ['tool-typecheck', 'pnpm exec tsc -p tools/img21/tsconfig.json'],
    ['protocol-bridge-typecheck', 'pnpm exec tsc -p tools/image-acceptance/tsconfig.json'],
    ['tool-tests', 'pnpm exec vitest run --config tools/img21/vitest.config.mts'],
    ['tool-synth', 'node --import tsx tools/img21/local-synth.ts'],
    ['tool-package', 'python3 scripts/test-support/image-mc03-tool-package.py'],
    ['tool-reproducibility', 'node --import tsx tools/img21/local-synth.ts (repeat; compare bytes)'],
    [
      'version-protocol-tests',
      'node --import tsx --test scripts/device-image-version-binding.test.mjs scripts/device-image-target-package.test.mjs',
    ],
    ['legacy-package-check', 'node scripts/device-image-target-package.mjs --check'],
  ];
  need(
    canonical(quality.independentChecks.map((r) => [r.id, r.command])) === canonical(independent),
    'INDEPENDENT_CHECK_SCOPE_NARROWED',
  );
  need(
    quality.mode === 'LOCAL_FIXTURES_ONLY' &&
      quality.fullVerifyExecution.command === 'pnpm verify' &&
      quality.fullVerifyExecution.exitCode === 0 &&
      Date.parse(quality.fullVerifyExecution.finishedAt) > Date.parse(quality.fullVerifyExecution.startedAt) &&
      quality.fullVerifyStages.every((r) => canonical(r.log) === canonical(quality.fullVerifyExecution.log)),
    'FULL_VERIFY_EXECUTION_NOT_BOUND',
  );
  const gates = [
    'device-contracts',
    'iot-integration',
    'core-api-integration',
    'admin-e2e',
    'security',
    'reliability',
    'prototype-regression',
  ];
  need(
    canonical(quality.specializedReceipts?.map((r) => r.id)) === canonical(gates),
    'SPECIALIZED_QUALITY_SCOPE_DRIFT',
  );
  for (const row of quality.specializedReceipts) {
    const receipt = refJson(row.artifact, read);
    need(
      row.status === 'PASS' && receipt.status === 'PASS' && receipt.baselineCommit === c.repositoryCandidate,
      'SPECIALIZED_QUALITY_SOURCE_DRIFT',
    );
  }
  need(
    quality.cloudCalls === 0 &&
      quality.g4 === 'NOT_RUN' &&
      refBytes(quality.guardLog, read).length === 0 &&
      refJson(quality.reproducibility, read).status === 'PASS',
    'LOCAL_QUALITY_SCOPE_INVALID',
  );
  const bundles = refJson(c.toolBundleManifest, read);
  need(
    bundles.artifacts?.length === 2 && bundles.lockSha256 === hash(blobsForLock(c.repositoryCandidate)),
    'TOOL_BUNDLE_MANIFEST_DRIFT',
  );
  const frozenSources = new Map(s.sources.map((r) => [r.path, r.sha256]));
  for (const b of bundles.artifacts)
    for (const [path, d] of Object.entries(b.inputs ?? {})) {
      need(sha(d), 'TOOL_INPUT_HASH_INVALID');
      if (frozenSources.has(path)) need(frozenSources.get(path) === d, 'FROZEN_TOOL_INPUT_DRIFT:' + path);
      else
        need(
          path.startsWith('node_modules/') || path.startsWith('packages/database/src/generated/'),
          'UNBOUND_TOOL_BUILD_INPUT:' + path,
        );
    }
  for (const t of c.executionTools) {
    need(
      t.sourceCommit === TOOLS &&
        sha(t.bareEntrySha256) &&
        bundles.artifacts.some((b) => b.kind === t.id && b.sha256 === t.bareEntrySha256),
      'TOOL_CODE_SOURCE_MISMATCH',
    );
  }
  if (requireCommitted) {
    for (const ref of [
      c.repositorySnapshot,
      c.quality,
      ...quality.fullVerifyStages.map((r) => r.log),
      ...quality.independentChecks.map((r) => r.log),
      c.toolBundleManifest,
      ...quality.specializedReceipts.map((r) => r.artifact),
      quality.guardLog,
      quality.reproducibility,
    ])
      need(
        gitFiles('' + git(['rev-parse', 'HEAD']).toString().trim(), [EVIDENCE + '/' + ref.path])[
          EVIDENCE + '/' + ref.path
        ].equals(refBytes(ref, read)),
        'UNCOMMITTED_QUALITY_EVIDENCE',
      );
  }
  return { status: 'PASS_LOCAL_FROZEN_CATALOG', candidate: c.repositoryCandidate, g4: 'NOT_RUN', cloudCalls: 0 };
}
export function compareApplicationSources(candidate, observed, deliveryPaths, verificationPaths, preparationPaths) {
  need(
    commit(candidate) && commit(observed) && Array.isArray(deliveryPaths) && deliveryPaths.length > 0,
    'INVALID_EQUIVALENCE_SCOPE',
  );
  const a = gitFiles(candidate, verificationPaths),
    b = gitFiles(observed, verificationPaths);
  const changedDelivery = deliveryPaths.filter((p) => hash(a[p]) !== hash(b[p]));
  const changedFull = verificationPaths.filter((p) => hash(a[p]) !== hash(b[p]));
  const build = BUILD_INPUTS.map((path) => ({
    path,
    candidate: git(['rev-parse', `${candidate}:${path}`])
      .toString()
      .trim(),
    observed: git(['rev-parse', `${observed}:${path}`])
      .toString()
      .trim(),
  }));
  const changedPaths = git(['diff', '--name-only', '--no-renames', '-z', observed, candidate])
    .toString()
    .split('\0')
    .filter(Boolean);
  const excluded = new Set(preparationPaths);
  const nonMetadata = changedPaths.filter(
    (p) =>
      !excluded.has(p) &&
      !p.startsWith('docs/audit/') &&
      !p.startsWith('docs/dev/') &&
      !['.gitattributes', 'docs/api/device-image-development-plan.md'].includes(p),
  );
  return {
    candidate,
    observed,
    deliveryCount: deliveryPaths.length,
    verificationCount: verificationPaths.length,
    changedDelivery,
    changedFull,
    build,
    changedPaths,
    nonMetadata,
    equal: changedDelivery.length === 0 && build.every((r) => r.candidate === r.observed) && nonMetadata.length === 0,
  };
}
const base64sha = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9+/]{43}=$/u.test(s) && Buffer.from(s, 'base64').length === 32;
const text = (v) => typeof v === 'string' && v.length > 0;
export function validateApplicationArtifacts(rows, expectedNames, sourceCommit) {
  need(
    Array.isArray(rows) &&
      rows.length === expectedNames.length &&
      new Set(rows.map((r) => r.name)).size === rows.length &&
      canonical(rows.map((r) => r.name).sort()) === canonical([...expectedNames].sort()),
    'APPLICATION_FUNCTION_INVENTORY_DRIFT',
  );
  for (const r of rows)
    need(
      r.sourceCommit === sourceCommit &&
        base64sha(r.codeSha256) &&
        sha(r.configurationHash) &&
        text(r.revisionId) &&
        r.state === 'Active' &&
        r.lastUpdateStatus === 'Successful' &&
        r.artifact?.sourceCommit === sourceCommit &&
        text(r.artifact.ciRunRef) &&
        text(r.artifact.s3Bucket) &&
        text(r.artifact.s3Key) &&
        text(r.artifact.versionId) &&
        r.artifact.versionId !== 'null' &&
        Number.isSafeInteger(r.artifact.sizeBytes) &&
        r.artifact.sizeBytes > 0 &&
        r.artifact.checksumType === 'FULL_OBJECT' &&
        r.artifact.sha256 === r.codeSha256,
      'APPLICATION_ARTIFACT_PROVENANCE_INVALID',
    );
  return rows;
}
export function validateRuntimeDetails(d, binding, appNames, authorityNames, input) {
  need(
    d?.formatVersion === 2 && canonical(d.versionBindingRef) === canonical(binding.ref),
    'RUNTIME_BINDING_REF_DRIFT',
  );
  need(
    d.observedDeployedCommit === binding.proof.observedDeployedCommit &&
      d.LIVE_IMAGE_CONTROL_TABLE === input.entries.controlTable.value &&
      d.LIVE_IMAGE_PAYLOAD_TABLE === input.entries.payloadTable.value,
    'RUNTIME_APPLICATION_BINDING_DRIFT',
  );
  need(
    Array.isArray(d.applicationRuntime) &&
      d.applicationRuntime.length === appNames.length &&
      new Set(d.applicationRuntime.map((r) => r.name)).size === appNames.length,
    'RUNTIME_INVENTORY_DRIFT',
  );
  for (const a of binding.proof.applicationArtifacts) {
    const r = d.applicationRuntime.find((r) => r.name === a.name);
    need(
      r &&
        r.codeSha256 === a.codeSha256 &&
        r.configurationHash === a.configurationHash &&
        r.revisionId === a.revisionId,
      'RUNTIME_CODE_CONFIGURATION_DRIFT',
    );
  }
  const names = [...authorityNames, 'fdp-test-img21-controlled-writer'].sort();
  need(
    Array.isArray(d.authorityWriters) && canonical(d.authorityWriters.map((r) => r.name).sort()) === canonical(names),
    'AUTHORITY_WRITER_INVENTORY_DRIFT',
  );
  for (const r of d.authorityWriters)
    need(
      r.controlTable === input.entries.controlTable.value &&
        r.payloadTable === input.entries.payloadTable.value &&
        sha(r.configurationHash) &&
        base64sha(r.codeSha256),
      'AUTHORITY_WRITER_CONFIGURATION_DRIFT',
    );
  for (const t of binding.proof.executionTools) {
    const r = d.toolRuntime?.find((r) => r.id === t.id);
    need(
      r &&
        r.sourceCommit === TOOLS &&
        r.qualifiedArn === t.qualifiedArn &&
        r.zipSha256 === t.zipRef.sha256 &&
        sha(r.observationRef?.sha256),
      'TOOL_CURRENT_RUNTIME_MISSING',
    );
  }
  const map = {
    adminApi: 'fdp-test-api',
    deviceApi: 'fdp-test-device-api-handler',
    ingestion: 'fdp-test-ingestion',
    mediaEvidence: 'fdp-test-media-evidence',
    outbox: 'fdp-test-outbox-publisher',
  };
  need(
    Object.keys(d.versions ?? {})
      .sort()
      .join() === Object.keys(map).sort().join() &&
      Object.entries(map).every(
        ([k, name]) => d.versions[k] === binding.proof.applicationArtifacts.find((r) => r.name === name)?.codeSha256,
      ),
    'FIVE_VERSION_DIGEST_DRIFT',
  );
  return true;
}
const brands = new WeakSet();
export function requireVersionPolicy(p) {
  need(p === undefined || brands.has(p), 'UNVERIFIED_VERSION_POLICY');
}
export function policyAllowsCommit(p, value) {
  requireVersionPolicy(p);
  return !!p && p.observed === value;
}
export function policyDetailsValid(p, id, d) {
  requireVersionPolicy(p);
  return !!p && p.details[id] === digest(d);
}
export function loadVersionPolicy(
  input,
  read,
  { catalog, comparison, appNames, authorityNames, validateTools, now = Date.now() },
) {
  need(
    input.versionBinding?.formatVersion === 2 &&
      ['STRICT', 'REVIEWED_SOURCE_EQUIVALENCE'].includes(input.versionBinding.mode),
    'EXPLICIT_VERSION_BINDING_MODE_REQUIRED',
  );
  const releaseRef =
    input.entries.deploymentProof.value && refJson(input.entries.deploymentProof.value, read).details.versionBindingRef;
  need(releaseRef, 'MISSING_RELEASE_BINDING');
  const proof = refJson(releaseRef, read),
    d = refJson(input.entries.deploymentProof.value, read).details,
    r = refJson(input.entries.runtimeVersionsProof.value, read).details;
  need(
    proof.formatVersion === 2 &&
      proof.mode === 'TARGET_CLOUD' &&
      proof.syntheticResponsesAllowed === false &&
      proof.applicationCandidate === APP &&
      proof.repositoryCandidate === catalog.repositoryCandidate &&
      proof.executionToolsSourceCommit === TOOLS &&
      canonical(proof.catalogRef) === canonical(input.versionBinding.catalogRef) &&
      proof.bindingMode === input.versionBinding.mode,
    'RELEASE_CATALOG_BINDING_DRIFT',
  );
  if (proof.bindingMode === 'STRICT')
    need(proof.observedDeployedCommit === APP && proof.reviewRef === null, 'STRICT_DEPLOYMENT_MISMATCH');
  else {
    need(
      comparison?.equal && comparison.candidate === APP && comparison.observed === proof.observedDeployedCommit,
      'SOURCE_EQUIVALENCE_NOT_ESTABLISHED',
    );
    const review = refJson(proof.reviewRef, read);
    need(
      review.kind === 'APPLICATION_SOURCE_EQUIVALENCE_REVIEW' &&
        review.mode === 'TARGET_REVIEW' &&
        review.syntheticResponsesAllowed === false &&
        review.decision === 'ACCEPT_APPLICATION_SOURCE_ONLY' &&
        review.repositoryCandidate === catalog.repositoryCandidate &&
        review.applicationCandidate === APP &&
        review.observedDeployedCommit === proof.observedDeployedCommit &&
        review.comparisonDigest === digest(comparison) &&
        text(review.reviewerRef) &&
        /^ref:/u.test(review.approvalRecordRef ?? '') &&
        iso(review.reviewedAt) &&
        iso(review.expiresAt) &&
        Date.parse(review.reviewedAt) <= now &&
        now < Date.parse(review.expiresAt),
      'MISSING_OR_INVALID_EQUIVALENCE_REVIEW',
    );
  }
  need(input.entries.deployedCommit.value === proof.observedDeployedCommit, 'OBSERVED_COMMIT_MUST_NOT_BE_RELABELED');
  validateApplicationArtifacts(proof.applicationArtifacts, appNames, proof.observedDeployedCommit);
  need(
    proof.preparationWindow &&
      iso(proof.preparationWindow.startsAt) &&
      iso(proof.preparationWindow.endsAt) &&
      Date.parse(proof.preparationWindow.endsAt) > Date.parse(proof.preparationWindow.startsAt) &&
      Date.parse(proof.preparationWindow.endsAt) - Date.parse(proof.preparationWindow.startsAt) <= 5400000 &&
      /^ref:/u.test(proof.preparationWindow.authorizationRef ?? ''),
    'PREPARATION_SCOPE_REQUIRED',
  );
  need(
    canonical(proof.executionTools?.map((t) => t.id)) === canonical(['writer', 'verifier']) &&
      proof.executionTools.every((t) => t.sourceCommit === TOOLS),
    'RELEASE_TOOLS_INVENTORY_DRIFT',
  );
  const normalized = { ref: releaseRef, proof };
  validateRuntimeDetails(r, normalized, appNames, authorityNames, input);
  need(
    d.formatVersion === 2 &&
      d.observedDeployedCommit === proof.observedDeployedCommit &&
      canonical(d.versions) === canonical(r.versions),
    'DEPLOYMENT_VERSION_DETAILS_DRIFT',
  );
  validateTools(proof, r, read, catalog);
  const policy = Object.freeze({
    observed: proof.observedDeployedCommit,
    mode: proof.bindingMode,
    details: Object.freeze({ deploymentProof: digest(d), runtimeVersionsProof: digest(r) }),
  });
  brands.add(policy);
  return policy;
}
export function directoryReader(directory) {
  const base = realpathSync(directory);
  return (p) => {
    const f = realpathSync(resolve(base, relativePath(p)));
    need(f.startsWith(base + '/'), 'ARTIFACT_OUTSIDE_BINDING_ROOT');
    return readFileSync(f);
  };
}
