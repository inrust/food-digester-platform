#!/usr/bin/env node
/** MC03 immutable candidate catalog and explicit V2 verifier; no account calls. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP,
  TOOLS,
  EVIDENCE,
  ROOT,
  hash,
  digest,
  canonical,
  need,
  git,
  gitFiles,
  sourceSnapshot,
  verifySnapshot,
  verifyCatalog,
  compareApplicationSources,
  loadVersionPolicy,
  refBytes,
  refJson,
  directoryReader,
} from './device-image-version-binding.mjs';
import {
  CANDIDATE,
  G3,
  PACKAGE,
  CLOUD_PROFILE,
  cloudAdmission,
  cloudInputTemplate,
  cloudReceiptTemplate,
  validateReceipt,
  artifactReader,
  verifyG3,
  protocolDigest,
  manifestRows,
  readG3EvidenceFiles,
  assertRedacted,
} from './device-image-target-package.mjs';
const E = resolve(ROOT, EVIDENCE);
const save = (p, data) => {
  const f = resolve(E, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n');
  return { path: p, sha256: hash(readFileSync(f)) };
};
const catalogRef = () => ({
  path: `${EVIDENCE}/frozen-candidate.json`,
  sha256: hash(readFileSync(resolve(E, 'frozen-candidate.json'))),
});
const sourceInventory =
  'docs/audit/evidence/2026-11-08-device-image-G4-readiness/observations/asset-full-object-sha256.json';
const historicalRelease = '69c76e1dd508bf6e03dd21992194a8280109cd0a';
const priorIntake = 'docs/audit/evidence/2026-11-08-device-image-fixture-execution/inputs.json';
export function applicationInventory() {
  const meta = JSON.parse(gitFiles(TOOLS, [sourceInventory])[sourceInventory]);
  const appNames = meta.lambdaArtifacts.map((a) => a.name).sort();
  const capacityPath = 'infra/src/database-capacity.ts';
  const source = gitFiles(APP, [capacityPath])[capacityPath].toString();
  const capacity = source.split('Object.freeze({').at(1).split('});').at(0);
  const authorityNames = [...capacity.matchAll(/^\s*(?:'([a-z-]+)'|([a-z]+)):\s*\d+,/gmu)]
    .map((m) => 'fdp-test-' + (m[1] ?? m[2]))
    .sort();
  need(
    appNames.length === 20 &&
      new Set(appNames).size === 20 &&
      authorityNames.length === 19 &&
      authorityNames.every((n) => appNames.includes(n)),
    'APPLICATION_INVENTORY_BASELINE_INVALID',
  );
  return { appNames, authorityNames };
}
export function sourceComparison(observed) {
  const names = ['sources.sha256', 'verification-sources.sha256'].map((n) => `${G3}/${n}`);
  const bytes = readG3EvidenceFiles(names),
    delivery = manifestRows(bytes[names[0]]).map((r) => r.path),
    full = manifestRows(bytes[names[1]]).map((r) => r.path);
  const ds = new Set(delivery);
  return compareApplicationSources(
    APP,
    observed,
    delivery,
    full,
    full.filter((p) => !ds.has(p)),
  );
}
export function verifyFrozen({ requireCommitted = true } = {}) {
  verifyG3();
  const read = directoryReader(E),
    raw = read('frozen-candidate.json'),
    catalog = JSON.parse(raw);
  assertRedacted(catalog);
  if (requireCommitted) {
    const path = EVIDENCE + '/frozen-candidate.json';
    need(gitFiles(git(['rev-parse', 'HEAD']).toString().trim(), [path])[path].equals(raw), 'UNCOMMITTED_CATALOG');
  }
  need(catalog.protocolDigest === protocolDigest() && catalog.defaultBindingMode === 'STRICT', 'PROTOCOL_DIGEST_DRIFT');
  need(
    canonical(catalog.applicationInventory) === canonical(applicationInventory()),
    'CATALOG_APPLICATION_INVENTORY_DRIFT',
  );
  need(canonical(catalog.applicationG3) === canonical(verifyG3()), 'APPLICATION_G3_BINDING_DRIFT');
  const comp = refJson(catalog.historicalComparison, read);
  need(
    comp.scope === 'HISTORICAL_SOURCE_COMPARISON_ONLY' &&
      comp.targetObservationsThisTask === 0 &&
      canonical(comp.comparison) === canonical(sourceComparison(historicalRelease)),
    'HISTORICAL_COMPARISON_DRIFT',
  );
  const result = verifyCatalog(catalog, read, { requireCommitted });
  return { ...result, catalog };
}
function toolProofs(proof, r, read, catalog, input, window, now) {
  need(
    Array.isArray(r.toolRuntime) && r.toolRuntime.length === 2 && new Set(r.toolRuntime.map((t) => t.id)).size === 2,
    'TOOL_RUNTIME_INVENTORY_DRIFT',
  );
  const tickets = [];
  for (const t of proof.executionTools) {
    const runtime = r.toolRuntime.find((row) => row.id === t.id);
    need(runtime, 'TOOL_RUNTIME_MISSING');
    const publication = refJson(t.publicationRef, read),
      current = refJson(runtime.observationRef, read),
      network = refJson(t.networkRef, read);
    for (const observed of [publication, current]) assertRedacted(observed);
    const time = Date.parse(current.capturedAt);
    need(
      Number.isFinite(time) && Date.parse(window.startsAt) <= time && time <= Math.min(now, Date.parse(window.endsAt)),
      'STALE_CURRENT_TOOL_OBSERVATION',
    );
    need(
      t.qualifiedArn === publication.qualifiedArn && t.qualifiedArn === current.qualifiedArn,
      'TOOL_QUALIFIED_ARN_DRIFT',
    );
    const manifest = refBytes(t.manifestRef, read).toString(),
      zip = refBytes(t.zipRef, read);
    need(zip.length <= 16 * 1024 * 1024, 'TOOL_ZIP_SIZE_LIMIT');
    const m = JSON.parse(manifest);
    assertRedacted(m);
    need(
      m.runId === input.runId &&
        m.verifierBinding?.deviceId === (t.id === 'writer' ? undefined : input.entries.deviceId.value) &&
        m.verifierBinding?.customerId === (t.id === 'writer' ? undefined : input.entries.customerId.value),
      'TOOL_RUN_OR_DEVICE_DRIFT',
    );
    need(
      t.artifact?.sourceCommit === TOOLS &&
        t.artifact.checksumType === 'FULL_OBJECT' &&
        t.artifact.sha256 === t.zipRef.sha256 &&
        t.artifact.sizeBytes === zip.length &&
        typeof t.artifact.versionId === 'string' &&
        !!t.artifact.versionId &&
        t.artifact.versionId !== 'null' &&
        typeof t.artifact.ciRunRef === 'string' &&
        !!t.artifact.ciRunRef &&
        typeof t.artifact.s3Bucket === 'string' &&
        !!t.artifact.s3Bucket &&
        typeof t.artifact.s3Key === 'string' &&
        !!t.artifact.s3Key,
      'TOOL_ARTIFACT_PROVENANCE_INVALID',
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/image-acceptance/validate-publication.ts'], {
      cwd: ROOT,
      input: JSON.stringify({
        id: t.id,
        manifest,
        manifestHash: t.manifestRef.sha256,
        zipBase64: zip.toString('base64'),
        publication,
        current,
        network,
        deviceId: input.entries.deviceId.value,
        preparationWindow: proof.preparationWindow,
        applicationCandidate: APP,
        toolSourceCommit: TOOLS,
        bareEntrySha256: catalog.executionTools.find((x) => x.id === t.id).bareEntrySha256,
      }),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
    need(result.status === 0 && !result.error, 'TOOL_SOURCE_PUBLICATION_NOT_PROVEN');
    const parsed = JSON.parse(result.stdout);
    need(parsed.status === 'PASS_SOURCE_BINDING_ONLY' && parsed.cloudCalls === 0, 'TOOL_SOURCE_PUBLICATION_NOT_PROVEN');
    tickets.push({ id: t.id, manifest: m, hash: t.manifestRef.sha256, ticket: parsed.ticket });
  }
  const [w, v] = tickets;
  const { verifierBinding: _b, verification: _v, ...stable } = v.manifest;
  need(
    digest({ ...stable, verifierBinding: null, verification: null }) === digest(w.manifest) && w.hash !== v.hash,
    'TOOL_MANIFEST_PAIR_DRIFT',
  );
  for (const a of r.authorityWriters) {
    const x =
      a.name === 'fdp-test-img21-controlled-writer'
        ? w.ticket
        : proof.applicationArtifacts.find((t) => t.name === a.name);
    need(
      x && a.codeSha256 === x.codeSha256 && a.configurationHash === x.configurationHash,
      'AUTHORITY_WRITER_VERSION_DRIFT',
    );
  }
}
export function inspectV2(input, read, { reviewed = false, receipt, now = Date.now() } = {}) {
  const result = cloudAdmission(input, read, now);
  // Preserve historical strict outcome; explicit V2 only replaces its version predicates.
  const base = {
    g4: 'NOT_RUN',
    cloudRequests: 0,
    executionReady: false,
    requiresRealExecutionReview: true,
    strictStatus: result.status,
    strictErrors: result.errors,
    thirdPartyAppRequired: false,
    physicalDeviceRequired: false,
  };
  try {
    need(
      input.profile === CLOUD_PROFILE &&
        input.versionBinding?.formatVersion === 2 &&
        input.versionBinding.mode === (reviewed ? 'REVIEWED_SOURCE_EQUIVALENCE' : 'STRICT'),
      'EXPLICIT_BINDING_MODE_REQUIRED',
    );
    for (const [key, value] of Object.entries({
      accountId: '065986019555',
      region: 'ap-southeast-1',
      stackName: 'fdp-test-app',
    })) {
      const actual = input.entries?.[key]?.value;
      need(actual === null || actual === value, 'V2_TARGET_SCOPE_DRIFT:' + key);
    }
    const { catalog } = verifyFrozen();
    need(canonical(input.versionBinding.catalogRef) === canonical(catalogRef()), 'FROZEN_CATALOG_REFERENCE_MISMATCH');
    const otherErrors = result.errors.filter(
      (e) =>
        ![
          'DEPLOYED_CANDIDATE_MISMATCH',
          'INVALID_TARGET_PROOF:deploymentProof',
          'INVALID_TARGET_PROOF:runtimeVersionsProof',
        ].includes(e),
    );
    if (otherErrors.length) return { ...base, status: 'FAIL', errors: otherErrors, blocked: result.blocked };
    if (receipt) {
      const { releaseRef, ...header } = receipt.versionBinding ?? {};
      need(canonical(header) === canonical(input.versionBinding), 'RECEIPT_V2_HEADER_DRIFT');
      if (receipt.execution === 'NOT_RUN') need(releaseRef === null, 'UNEXECUTED_RELEASE_CLAIM');
    }
    if (receipt?.execution === 'NOT_RUN') return { ...validateReceipt(receipt, input, read), ...base };
    if (result.blocked.length) return { ...base, status: 'BLOCKED', blocked: result.blocked, errors: [] };
    const w = refJson(input.entries.executionWindowProof.value, read);
    const window = w.details;
    if (now < Date.parse(window.startsAt) || now > Date.parse(window.endsAt))
      return {
        ...base,
        status: 'BLOCKED',
        blocked: [{ id: 'executionWindowProof', reason: 'VERSION_OBSERVATION_WINDOW_NOT_OPEN' }],
        errors: [],
      };
    const d = refJson(input.entries.deploymentProof.value, read),
      r = refJson(input.entries.runtimeVersionsProof.value, read);
    for (const p of [d, r])
      need(
        Date.parse(window.startsAt) <= Date.parse(p.capturedAt) && Date.parse(p.capturedAt) <= now,
        'STALE_APPLICATION_VERSION_OBSERVATION',
      );
    const release = refJson(d.details.versionBindingRef, read);
    assertRedacted(release);
    if (reviewed && !release.reviewRef)
      return {
        ...base,
        status: 'BLOCKED',
        blocked: [{ id: 'equivalenceReview', reason: 'EXPLICIT_SOURCE_EQUIVALENCE_REVIEW_MISSING' }],
        errors: [],
      };
    if (receipt)
      need(
        canonical(receipt.versionBinding) ===
          canonical({ ...input.versionBinding, releaseRef: d.details.versionBindingRef }),
        'RECEIPT_RELEASE_BINDING_DRIFT',
      );
    const comparison = reviewed ? sourceComparison(release.observedDeployedCommit) : undefined;
    const policy = loadVersionPolicy(input, read, {
      catalog,
      comparison,
      ...catalog.applicationInventory,
      validateTools: (proof, runtime, reader, c) => toolProofs(proof, runtime, reader, c, input, window, now),
      now,
    });
    const checked = receipt
      ? validateReceipt(receipt, input, read, undefined, policy)
      : cloudAdmission(input, read, now, policy);
    return {
      ...checked,
      ...base,
      bindingMode: policy.mode,
      applicationCandidate: APP,
      observedDeployedCommit: policy.observed,
    };
  } catch (e) {
    return { ...base, status: 'FAIL', errors: [String(e.message)], blocked: result.blocked };
  }
}
export function draftInput(catalog) {
  const historical = JSON.parse(gitFiles(TOOLS, [priorIntake])[priorIntake]);
  const input = cloudInputTemplate();
  for (const [id, row] of Object.entries(input.entries)) {
    const old = historical.entries[id];
    if (row.kind !== 'proof' && old?.value !== null && old?.value !== undefined) row.value = old.value;
  }
  input.runId = null;
  input.versionBinding = {
    formatVersion: 2,
    mode: 'STRICT',
    catalogRef: { path: `${EVIDENCE}/frozen-candidate.json`, sha256: catalog },
  };
  return input;
}
export function freezeLocalEvidence(c, quality, bundleManifest) {
  need(APP === CANDIDATE, 'APPLICATION_CANDIDATE_CONSTANT_DRIFT');
  const snapshot = sourceSnapshot(c);
  verifySnapshot(snapshot);
  const appG3 = verifyG3(),
    snapshotRef = save('repository-snapshot.json', snapshot);
  const comparison = sourceComparison(historicalRelease);
  need(comparison.equal, 'HISTORICAL_SOURCE_COMPARISON_FAILED');
  const historical = save('historical-source-comparison.json', {
    scope: 'HISTORICAL_SOURCE_COMPARISON_ONLY',
    targetObservationsThisTask: 0,
    reviewAccepted: false,
    comparison,
  });
  const bm = save('tool-bundle-manifest.json', bundleManifest);
  const q = save('quality-receipt.json', { ...quality, repositoryCandidate: c, snapshotDigest: snapshotRef.sha256 });
  const catalog = {
    formatVersion: 2,
    repositoryCandidate: c,
    applicationCandidate: APP,
    executionToolsSourceCommit: TOOLS,
    protocolSourceCommit: c,
    defaultBindingMode: 'STRICT',
    protocolDigest: protocolDigest(),
    repositorySnapshot: snapshotRef,
    applicationG3: appG3,
    applicationInventory: applicationInventory(),
    historicalComparison: historical,
    quality: q,
    toolBundleManifest: bm,
    toolSources: snapshot.sources.filter(
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
    ),
    executionTools: bundleManifest.artifacts.map((b) => ({
      id: b.kind,
      entry: `tools/img21/${b.kind}-entry.ts`,
      sourceCommit: TOOLS,
      authorityWriter: b.kind === 'writer',
      bareEntrySha256: b.sha256,
      publication: 'NOT_RUN',
    })),
    currentTarget: { deployedCommit: null, versionBindingRef: null, reviewRef: null, g4: 'NOT_RUN' },
  };
  const ref = save('frozen-candidate.json', catalog);
  save('inputs-v2.draft.json', draftInput(ref.sha256));
  save('receipt-v2.template.json', {
    ...cloudReceiptTemplate(),
    versionBinding: {
      formatVersion: 2,
      mode: 'STRICT',
      catalogRef: { path: `${EVIDENCE}/frozen-candidate.json`, sha256: ref.sha256 },
      releaseRef: null,
    },
  });
  const catalogBinding = { path: `${EVIDENCE}/frozen-candidate.json`, sha256: ref.sha256 };
  save('release-binding-v2.template.json', {
    status: 'NOT_RUN',
    formatVersion: 2,
    mode: 'TARGET_CLOUD',
    syntheticResponsesAllowed: false,
    bindingMode: 'STRICT',
    catalogRef: catalogBinding,
    applicationCandidate: APP,
    repositoryCandidate: c,
    executionToolsSourceCommit: TOOLS,
    observedDeployedCommit: null,
    reviewRef: null,
    preparationWindow: { startsAt: null, endsAt: null, authorizationRef: null },
    applicationArtifacts: catalog.applicationInventory.appNames.map((name) => ({
      name,
      sourceCommit: null,
      codeSha256: null,
      configurationHash: null,
      revisionId: null,
      state: null,
      lastUpdateStatus: null,
      artifact: {
        sourceCommit: null,
        ciRunRef: null,
        s3Bucket: null,
        s3Key: null,
        versionId: null,
        sizeBytes: null,
        checksumType: null,
        sha256: null,
      },
    })),
    executionTools: catalog.executionTools.map((t) => ({
      id: t.id,
      sourceCommit: TOOLS,
      qualifiedArn: null,
      manifestRef: null,
      zipRef: null,
      publicationRef: null,
      networkRef: null,
      artifact: null,
    })),
  });
  save('version-details-v2.templates.json', {
    status: 'NOT_RUN',
    deployment: { formatVersion: 2, observedDeployedCommit: null, versions: null, versionBindingRef: null },
    runtime: {
      formatVersion: 2,
      observedDeployedCommit: null,
      versions: null,
      versionBindingRef: null,
      LIVE_IMAGE_CONTROL_TABLE: null,
      LIVE_IMAGE_PAYLOAD_TABLE: null,
      applicationRuntime: catalog.applicationInventory.appNames.map((name) => ({
        name,
        codeSha256: null,
        configurationHash: null,
        revisionId: null,
      })),
      authorityWriters: [...catalog.applicationInventory.authorityNames, 'fdp-test-img21-controlled-writer'].map(
        (name) => ({ name, controlTable: null, payloadTable: null, configurationHash: null, codeSha256: null }),
      ),
      toolRuntime: catalog.executionTools.map((t) => ({
        id: t.id,
        sourceCommit: TOOLS,
        qualifiedArn: null,
        zipSha256: null,
        observationRef: null,
      })),
    },
  });
  const result = verifyFrozen({ requireCommitted: false });
  return {
    status: result.status,
    candidate: c,
    inventoryCount: snapshot.inventory.length,
    sourceCount: snapshot.sources.length,
    catalogSha256: ref.sha256,
    applicationG3: appG3.g3,
    g4: 'NOT_RUN',
    cloudCalls: 0,
  };
}
export function main(args) {
  if (args.length === 1 && args[0] === '--check') {
    const { catalog, ...status } = verifyFrozen();
    return {
      ...status,
      applicationCandidate: catalog.applicationCandidate,
      toolSourceCommit: catalog.executionToolsSourceCommit,
      protocolDigest: catalog.protocolDigest,
      legacyPackage: PACKAGE,
    };
  }
  if (
    args[0] === '--admission-v2' &&
    (args.length === 2 || (args.length === 3 && args[2] === '--reviewed-equivalence'))
  ) {
    const f = resolve(args[1]);
    return inspectV2(JSON.parse(readFileSync(f)), artifactReader(dirname(f)), { reviewed: args.length === 3 });
  }
  if (
    args[0] === '--receipt-v2' &&
    (args.length === 3 || (args.length === 4 && args[3] === '--reviewed-equivalence'))
  ) {
    const f = resolve(args[1]),
      receipt = JSON.parse(readFileSync(f));
    return inspectV2(JSON.parse(readFileSync(resolve(args[2]))), artifactReader(dirname(f)), {
      reviewed: args.length === 4,
      receipt,
      now: Date.parse(receipt.finishedAt),
    });
  }
  throw Error(
    'USAGE: --check | --admission-v2 INPUT [--reviewed-equivalence] | --receipt-v2 RECEIPT INPUT [--reviewed-equivalence]; offline only',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (['FAIL', 'BLOCKED', 'NOT_RUN'].includes(result.status)) process.exitCode = result.status === 'FAIL' ? 1 : 2;
  } catch (e) {
    process.stderr.write(String(e) + '\n');
    process.exitCode = 1;
  }
}
