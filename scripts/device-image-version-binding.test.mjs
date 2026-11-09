import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  APP,
  TOOLS,
  canonical,
  digest,
  hash,
  refBytes,
  requireVersionPolicy,
  loadVersionPolicy,
  validateApplicationArtifacts,
  validateRuntimeDetails,
} from './device-image-version-binding.mjs';
import { sourceComparison, applicationInventory, draftInput } from './device-image-candidate.mjs';
import { cloudAdmission, cloudInputTemplate } from './device-image-target-package.mjs';
import { fixtureInput, FIXTURE_NOW } from '../tools/img21/local-fixture.ts';
import { renderWriterManifest, renderVerifierManifest } from '../tools/img21/manifests.ts';
import { packageLambda } from '../tools/img21/archive.ts';
import { TARGET, jsonHash } from '../tools/img21/contracts.ts';
import {
  boundaryArn,
  functionArn,
  roleArn,
  writerPolicy,
  writerBoundary,
  verifierPolicy,
  runtimeTrust,
} from '../tools/img21/policies.ts';
const OLD = '69c76e1dd508bf6e03dd21992194a8280109cd0a',
  now = FIXTURE_NOW;
const iso = (t) => new Date(t).toISOString();
const h = 'a'.repeat(64),
  sha64 = Buffer.from(h, 'hex').toString('base64');
const inv = applicationInventory();
function fixture(mode = 'STRICT') {
  const files = new Map(),
    store = (p, v) => {
      const b = Buffer.from(JSON.stringify(v));
      files.set(p, b);
      return { path: p, sha256: hash(b) };
    };
  const input = cloudInputTemplate(),
    catalog = { repositoryCandidate: TOOLS },
    catalogRef = { path: 'catalog.json', sha256: h };
  input.versionBinding = { formatVersion: 2, mode, catalogRef };
  input.entries.deployedCommit.value = mode === 'STRICT' ? APP : OLD;
  input.entries.controlTable.value = TARGET.controlTable;
  input.entries.payloadTable.value = TARGET.payloadTable;
  const c = input.entries.deployedCommit.value,
    app = inv.appNames.map((name) => ({
      name,
      sourceCommit: c,
      codeSha256: sha64,
      configurationHash: h,
      revisionId: 'local-fixture',
      state: 'Active',
      lastUpdateStatus: 'Successful',
      artifact: {
        sourceCommit: c,
        ciRunRef: 'ref:local-fixture',
        s3Bucket: 'local-fixture',
        s3Key: 'a.zip',
        versionId: 'fixed',
        sizeBytes: 100,
        checksumType: 'FULL_OBJECT',
        sha256: sha64,
      },
    }));
  const comparison = { candidate: APP, observed: OLD, equal: true };
  const review = {
    kind: 'APPLICATION_SOURCE_EQUIVALENCE_REVIEW',
    mode: 'TARGET_REVIEW',
    syntheticResponsesAllowed: false,
    decision: 'ACCEPT_APPLICATION_SOURCE_ONLY',
    repositoryCandidate: TOOLS,
    applicationCandidate: APP,
    observedDeployedCommit: OLD,
    comparisonDigest: digest(comparison),
    reviewerRef: 'ref:local-test',
    approvalRecordRef: 'ref:local-test',
    reviewedAt: iso(now - 1000),
    expiresAt: iso(now + 60000),
  };
  const p = {
    formatVersion: 2,
    mode: 'TARGET_CLOUD',
    syntheticResponsesAllowed: false,
    applicationCandidate: APP,
    repositoryCandidate: TOOLS,
    executionToolsSourceCommit: TOOLS,
    catalogRef,
    bindingMode: mode,
    observedDeployedCommit: c,
    reviewRef: null,
    applicationArtifacts: app,
    preparationWindow: { startsAt: iso(now - 1000), endsAt: iso(now + 60000), authorizationRef: 'ref:local-test' },
    executionTools: ['writer', 'verifier'].map((id) => ({
      id,
      sourceCommit: TOOLS,
      qualifiedArn: functionArn(id) + ':37',
      zipRef: { path: id + '.zip', sha256: h },
    })),
  };
  const versions = Object.fromEntries(
    ['adminApi', 'deviceApi', 'ingestion', 'mediaEvidence', 'outbox'].map((k) => [k, sha64]),
  );
  const d = { formatVersion: 2, observedDeployedCommit: c, versions };
  const runtime = {
    ...d,
    LIVE_IMAGE_CONTROL_TABLE: TARGET.controlTable,
    LIVE_IMAGE_PAYLOAD_TABLE: TARGET.payloadTable,
    applicationRuntime: app.map((a) => ({ ...a })),
    authorityWriters: [...inv.authorityNames, 'fdp-test-img21-controlled-writer'].map((name) => ({
      name,
      controlTable: TARGET.controlTable,
      payloadTable: TARGET.payloadTable,
      configurationHash: h,
      codeSha256: sha64,
    })),
    toolRuntime: p.executionTools.map((t) => ({
      id: t.id,
      sourceCommit: TOOLS,
      qualifiedArn: t.qualifiedArn,
      zipSha256: h,
      observationRef: { path: t.id + '.json', sha256: h },
    })),
  };
  return {
    input,
    p,
    d,
    runtime,
    app,
    review,
    comparison,
    catalog,
    read: (p) => files.get(p),
    seal() {
      p.reviewRef = mode === 'STRICT' ? null : store('review.json', review);
      const binding = store('binding.json', p);
      d.versionBindingRef = binding;
      runtime.versionBindingRef = binding;
      input.entries.deploymentProof.value = store('deployment.json', { details: d });
      input.entries.runtimeVersionsProof.value = store('runtime.json', { details: runtime });
    },
    load(validateTools = () => {}) {
      this.seal();
      return loadVersionPolicy(input, this.read, { catalog, comparison, ...inv, validateTools, now });
    },
  };
}
test('actual historical source comparison recomputes 1693 unchanged delivery files, 8 build inputs and 12 preparation differences', () => {
  const c = sourceComparison(OLD);
  assert.equal(c.equal, true);
  assert.equal(c.deliveryCount, 1693);
  assert.equal(c.verificationCount, 1713);
  assert.equal(c.changedFull.length, 12);
  assert.equal(c.build.length, 8);
  assert.equal(c.observed, OLD);
  assert.equal(c.candidate, APP);
});
test('independent tool and authority inventory remains exact', () => {
  assert.equal(inv.appNames.length, 20);
  assert.equal(inv.authorityNames.length, 19);
  assert.ok(inv.appNames.includes('fdp-test-archive'));
  assert.ok(!inv.authorityNames.includes('fdp-test-archive'));
});
test('V2 draft carries only 9 retained scalar values and no stale migration/cleanup proofs', () => {
  const input = draftInput(h);
  assert.equal(Object.values(input.entries).filter((e) => e.value !== null).length, 9);
  assert.equal(input.entries.migrationProof.value, null);
  assert.equal(input.entries.cleanupPlan.value, null);
  assert.equal(input.versionBinding.mode, 'STRICT');
});
test('legacy strict rejects historical commit, and plain JSON cannot override predicates', () => {
  const input = cloudInputTemplate();
  input.entries.deployedCommit.value = OLD;
  input.versionBinding = { formatVersion: 2, mode: 'REVIEWED_SOURCE_EQUIVALENCE' };
  assert.ok(cloudAdmission(input, () => {}).errors.includes('DEPLOYED_CANDIDATE_MISMATCH'));
  assert.throws(() => requireVersionPolicy({ observed: OLD }), /UNVERIFIED_VERSION_POLICY/);
});
test('explicit strict V2 keeps actual deployed SHA and calls the independent tools validator', () => {
  const f = fixture();
  let tools = 0;
  const p = f.load(() => {
    tools++;
  });
  assert.equal(tools, 1);
  assert.equal(p.observed, APP);
  assert.equal(p.mode, 'STRICT');
  assert.ok(Object.isFrozen(p.details));
});
test('reviewed equivalence retains both SHAs and does not convert to strict', () => {
  const f = fixture('REVIEWED_SOURCE_EQUIVALENCE');
  const p = f.load();
  assert.equal(p.observed, OLD);
  assert.equal(p.mode, 'REVIEWED_SOURCE_EQUIVALENCE');
  assert.equal(f.input.entries.deployedCommit.value, OLD);
});
for (const [name, mutate, error] of [
  [
    'wrong candidate',
    (f) => {
      f.p.repositoryCandidate = 'b'.repeat(40);
    },
    /RELEASE_CATALOG_BINDING_DRIFT/,
  ],
  [
    'synthetic source',
    (f) => {
      f.p.syntheticResponsesAllowed = true;
    },
    /RELEASE_CATALOG_BINDING_DRIFT/,
  ],
  [
    'strict history',
    (f) => {
      f.p.observedDeployedCommit = OLD;
    },
    /STRICT_DEPLOYMENT_MISMATCH/,
  ],
  [
    'relabel',
    (f) => {
      f.input.entries.deployedCommit.value = 'b'.repeat(40);
    },
    /OBSERVED_COMMIT_MUST_NOT_BE_RELABELED/,
  ],
  [
    'wrong CI SHA',
    (f) => {
      f.p.applicationArtifacts[0].artifact.sourceCommit = OLD;
    },
    /APPLICATION_ARTIFACT_PROVENANCE_INVALID/,
  ],
  [
    'null S3 version',
    (f) => {
      f.p.applicationArtifacts[0].artifact.versionId = 'null';
    },
    /APPLICATION_ARTIFACT_PROVENANCE_INVALID/,
  ],
  [
    'composite checksum',
    (f) => {
      f.p.applicationArtifacts[0].artifact.checksumType = 'COMPOSITE';
    },
    /APPLICATION_ARTIFACT_PROVENANCE_INVALID/,
  ],
  [
    'mismatched full object',
    (f) => {
      f.p.applicationArtifacts[0].artifact.sha256 = Buffer.alloc(32, 7).toString('base64');
    },
    /APPLICATION_ARTIFACT_PROVENANCE_INVALID/,
  ],
  [
    'missing function',
    (f) => {
      f.p.applicationArtifacts.pop();
    },
    /APPLICATION_FUNCTION_INVENTORY_DRIFT/,
  ],
  [
    'duplicate function',
    (f) => {
      f.p.applicationArtifacts[1] = f.p.applicationArtifacts[0];
    },
    /APPLICATION_FUNCTION_INVENTORY_DRIFT/,
  ],
  [
    'runtime configuration drift',
    (f) => {
      f.runtime.applicationRuntime[0].configurationHash = 'f'.repeat(64);
    },
    /RUNTIME_CODE_CONFIGURATION_DRIFT/,
  ],
  [
    'runtime revision drift',
    (f) => {
      f.runtime.applicationRuntime[0].revisionId = 'different';
    },
    /RUNTIME_CODE_CONFIGURATION_DRIFT/,
  ],
  [
    'missing new Writer',
    (f) => {
      f.runtime.authorityWriters.pop();
    },
    /AUTHORITY_WRITER_INVENTORY_DRIFT/,
  ],
  [
    'old authority runtime table drift',
    (f) => {
      f.runtime.authorityWriters[0].controlTable = 'wrong';
    },
    /AUTHORITY_WRITER_CONFIGURATION_DRIFT/,
  ],
  [
    'missing verifier',
    (f) => {
      f.p.executionTools.pop();
    },
    /RELEASE_TOOLS_INVENTORY_DRIFT/,
  ],
  [
    'wrong tool source',
    (f) => {
      f.p.executionTools[0].sourceCommit = APP;
    },
    /RELEASE_TOOLS_INVENTORY_DRIFT/,
  ],
  [
    'runtime qualified drift',
    (f) => {
      f.runtime.toolRuntime[0].qualifiedArn += ':alias';
    },
    /TOOL_CURRENT_RUNTIME_MISSING/,
  ],
  [
    'expired prep shape',
    (f) => {
      f.p.preparationWindow.endsAt = iso(now + 6000000);
    },
    /PREPARATION_SCOPE_REQUIRED/,
  ],
])
  test(`V2 rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => f.load(), error);
  });
for (const [name, mutate, error] of [
  [
    'different source',
    (f) => {
      f.comparison.equal = false;
    },
    /SOURCE_EQUIVALENCE_NOT_ESTABLISHED/,
  ],
  [
    'expired review',
    (f) => {
      f.review.expiresAt = iso(now);
    },
    /MISSING_OR_INVALID_EQUIVALENCE_REVIEW/,
  ],
  [
    'wrong comparison',
    (f) => {
      f.review.comparisonDigest = 'b'.repeat(64);
    },
    /MISSING_OR_INVALID_EQUIVALENCE_REVIEW/,
  ],
  [
    'boolean only',
    (f) => {
      f.review.decision = true;
    },
    /MISSING_OR_INVALID_EQUIVALENCE_REVIEW/,
  ],
  [
    'approval missing',
    (f) => {
      f.review.approvalRecordRef = null;
    },
    /MISSING_OR_INVALID_EQUIVALENCE_REVIEW/,
  ],
])
  test(`reviewed mode rejects ${name}`, () => {
    const f = fixture('REVIEWED_SOURCE_EQUIVALENCE');
    mutate(f);
    assert.throws(() => f.load(), error);
  });
test('artifact reference rejects traversal, substitution and duplicate/extra scope', () => {
  assert.throws(() => refBytes({ path: '../x', sha256: h }, () => Buffer.alloc(0)), /INVALID_BINDING_PATH/);
  assert.throws(() => refBytes({ path: 'x', sha256: h }, () => Buffer.alloc(0)), /HASH_DRIFT/);
  assert.throws(
    () => refBytes({ path: 'x', sha256: h, other: true }, () => Buffer.alloc(0)),
    /INVALID_BINDING_REFERENCE/,
  );
});
test('tool validator failure cannot mint a V2 policy', () => {
  const f = fixture();
  assert.throws(
    () =>
      f.load(() => {
        throw Error('TOOL_SOURCE_PUBLICATION_NOT_PROVEN');
      }),
    /TOOL_SOURCE_PUBLICATION_NOT_PROVEN/,
  );
});
test('runtime proof requires same version binding and five exact primary identities', () => {
  const f = fixture();
  f.seal();
  const binding = { ref: f.d.versionBindingRef, proof: f.p };
  assert.equal(validateRuntimeDetails(f.runtime, binding, inv.appNames, inv.authorityNames, f.input), true);
  f.runtime.versionBindingRef = { path: 'other', sha256: h };
  assert.throws(
    () => validateRuntimeDetails(f.runtime, binding, inv.appNames, inv.authorityNames, f.input),
    /RUNTIME_BINDING_REF_DRIFT/,
  );
  assert.throws(() => validateApplicationArtifacts(f.app, inv.appNames, OLD), /PROVENANCE/);
});
function bridgeFixture(id) {
  const f = fixtureInput();
  f.manifest.toolCommit = TOOLS;
  const w = renderWriterManifest(f.manifest),
    bound = id === 'writer' ? w : renderVerifierManifest(w, f.snapshot, now),
    code = Buffer.from('export const handler=()=>{}'),
    packed = packageLambda(code, bound);
  const vars = {
    IMG21_MANIFEST_SHA256: bound.hash,
    ...(id === 'writer'
      ? {
          LIVE_IMAGE_CONTROL_TABLE: TARGET.controlTable,
          LIVE_IMAGE_PAYLOAD_TABLE: TARGET.payloadTable,
          FDP_DB_POOL_MAX: '1',
        }
      : {}),
  };
  const obs = {
    capturedAt: iso(now),
    accountId: TARGET.accountId,
    principalArn: `arn:aws:sts::${TARGET.accountId}:assumed-role/FDP-ReadOnlyOps/local`,
    qualifiedArn: functionArn(id) + ':37',
    configuration: {
      Version: '37',
      FunctionArn: functionArn(id) + ':37',
      CodeSha256: packed.codeSha256,
      EnvironmentHash: jsonHash(vars),
      Runtime: 'nodejs24.x',
      PackageType: 'Zip',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 30,
      MemorySize: id === 'writer' ? 512 : 256,
      State: 'Active',
      LastUpdateStatus: 'Successful',
      Role: roleArn(id),
      RevisionId: 'local',
      LoggingConfig: {
        LogGroup: '/aws/lambda/fdp-test-img21-' + (id === 'writer' ? 'controlled-writer' : 'license-verifier'),
        LogFormat: 'JSON',
      },
      ...(id === 'writer'
        ? {
            VpcConfig: {
              VpcId: f.network.vpcId,
              SubnetIds: f.network.subnetIds,
              SecurityGroupIds: f.network.securityGroupIds,
            },
          }
        : {}),
    },
    concurrency: 1,
    runtime: {
      UpdateRuntimeOn: 'FunctionUpdate',
      RuntimeVersionArn: 'arn:aws:lambda:ap-southeast-1::runtime:' + 'b'.repeat(64),
    },
    asyncConfig: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
    resourcePoliciesAbsent: true,
    role: {
      arn: roleArn(id),
      boundaryArn: boundaryArn(id),
      trust: runtimeTrust(),
      inlineNames: ['IMG21Runtime'],
      attachedPolicyArns: [],
      inline: id === 'writer' ? writerPolicy('B', f.snapshot.binding.deviceId) : verifierPolicy(),
      boundary: id === 'writer' ? writerBoundary() : verifierPolicy(),
    },
  };
  return {
    id,
    manifest: canonical(bound.manifest),
    manifestHash: bound.hash,
    zipBase64: packed.bytes.toString('base64'),
    publication: obs,
    current: { ...structuredClone(obs), capturedAt: iso(now + 600000) },
    network: f.network,
    deviceId: f.snapshot.binding.deviceId,
    preparationWindow: { startsAt: iso(now - 1000), endsAt: iso(now + 600000) },
    applicationCandidate: APP,
    toolSourceCommit: TOOLS,
    bareEntrySha256: hash(code),
  };
}
const bridge = (input) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'tools/image-acceptance/validate-publication.ts'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
for (const id of ['writer', 'verifier'])
  test(`real ${id} ZIP/manifest/MC02 verifier bridge binds code only, not another invocation`, () => {
    const p = bridge(bridgeFixture(id));
    assert.equal(p.status, 0, p.stderr);
    const v = JSON.parse(p.stdout);
    assert.equal(v.status, 'PASS_SOURCE_BINDING_ONLY');
    assert.equal(v.g4, 'NOT_RUN');
  });
test('bridge rejects copied tool source, changed code and mutable runtime drift', () => {
  for (const mutate of [
    (x) => {
      x.toolSourceCommit = APP;
    },
    (x) => {
      x.bareEntrySha256 = 'b'.repeat(64);
    },
    (x) => {
      x.current.role.attachedPolicyArns.push('changed');
    },
    (x) => {
      x.preparationWindow.startsAt = iso(now + 1);
    },
  ]) {
    const f = bridgeFixture('verifier');
    mutate(f);
    assert.equal(bridge(f).status, 1);
  }
});
