import { expect, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '../contracts.js';
import { bindManifest, canonical, checkInvocation, digest, jsonHash, TARGET } from '../contracts.js';
import {
  renderWriterManifest,
  renderVerifierManifest,
  validateManifestPair,
  manifestPairReceipt,
} from '../manifests.js';
import { packageLambda, verifyLambdaPackage } from '../archive.js';
import { checkBudget, checkNetwork, Img21ToolsStack } from '../infra.js';
import { fixtureInput, FIXTURE_NOW as NOW } from '../local-fixture.js';
import {
  boundaryArn,
  controlPlaneDelta,
  functionArn,
  roleArn,
  writerPolicy,
  writerBoundary,
  verifierPolicy,
  runtimeTrust,
  reviewedControlPlanePatch,
} from '../policies.js';
import {
  validatePublished,
  invokePolicy,
  createReadOnlyPublicationObserver,
  safeConfiguration,
  prepareInvokePolicy,
} from '../publication.js';
import type { ExpectedPublication, Kind, PublishedObservation } from '../publication.js';
import type { ToolAsset, ToolStackProps } from '../infra.js';
import { validatePhaseB } from '../phase-b.js';
function pair() {
  const f = fixtureInput(),
    writer = renderWriterManifest(f.manifest),
    verifier = renderVerifierManifest(writer, f.snapshot, NOW);
  return { ...f, writer, verifier };
}
function observation(kind: Kind = 'writer') {
  const f = pair(),
    bound = kind === 'writer' ? f.writer : f.verifier;
  const asset: ToolAsset = {
    path: 'LOCAL_FIXTURE.zip',
    sha256: 'a'.repeat(64),
    codeSha256: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
    manifestHash: bound.hash,
  };
  const expected: ExpectedPublication = {
    kind,
    bound,
    asset,
    policy: kind === 'writer' ? writerPolicy('B', f.snapshot.binding.deviceId) : verifierPolicy(),
    boundary: kind === 'writer' ? writerBoundary() : verifierPolicy(),
    network: f.network,
  };
  const vars = {
    IMG21_MANIFEST_SHA256: bound.hash,
    ...(kind === 'writer'
      ? {
          LIVE_IMAGE_CONTROL_TABLE: TARGET.controlTable,
          LIVE_IMAGE_PAYLOAD_TABLE: TARGET.payloadTable,
          FDP_DB_POOL_MAX: '1',
        }
      : {}),
  };
  const o: PublishedObservation = {
    capturedAt: new Date(NOW).toISOString(),
    accountId: TARGET.accountId,
    principalArn: `arn:aws:sts::${TARGET.accountId}:assumed-role/FDP-ReadOnlyOps/local-fixture`,
    qualifiedArn: functionArn(kind) + ':37',
    configuration: {
      Version: '37',
      FunctionArn: functionArn(kind) + ':37',
      CodeSha256: asset.codeSha256,
      EnvironmentHash: jsonHash(vars),
      PackageType: 'Zip',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 30,
      MemorySize: kind === 'writer' ? 512 : 256,
      State: 'Active',
      LastUpdateStatus: 'Successful',
      Role: roleArn(kind),
      RevisionId: 'fixture-revision',
      LoggingConfig: {
        LogGroup: '/aws/lambda/fdp-test-img21-' + (kind === 'writer' ? 'controlled-writer' : 'license-verifier'),
        LogFormat: 'JSON',
      },
      ...(kind === 'writer'
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
      arn: roleArn(kind),
      boundaryArn: boundaryArn(kind),
      trust: runtimeTrust(),
      inlineNames: ['IMG21Runtime'],
      attachedPolicyArns: [],
      inline: expected.policy,
      boundary: expected.boundary,
    },
  };
  return { ...f, bound, expected, o };
}
test('independent manifests retain immutable Writer bytes and freeze source-observation expiry', () => {
  const f = pair(),
    before = f.writer.hash;
  expect(f.writer.manifest.writerVersion).toBe('PUBLISHED');
  expect(f.verifier.hash).not.toBe(before);
  validateManifestPair(f.writer, f.verifier);
  expect(f.verifier.manifest.verification?.observedAt).toBe(f.snapshot.observedAt);
  expect(Date.parse(f.verifier.manifest.verification!.expiresAt) - NOW).toBe(300000);
  renderVerifierManifest(f.writer, { ...f.snapshot, licenseVersion: 2, snapshotEtag: 'f'.repeat(64) }, NOW + 1000);
  expect(f.writer.hash).toBe(before);
});
for (const delta of [300000, 300001, -1])
  test(`snapshot source clock ${delta}ms is rejected instead of extending TTL`, () => {
    const f = pair();
    expect(() => renderVerifierManifest(f.writer, f.snapshot, NOW + delta)).toThrow('SNAPSHOT_STALE_OR_FUTURE');
  });
test('delayed rendering spends TTL and expiry is clipped at execution-window end', () => {
  const f = pair(),
    v = renderVerifierManifest(f.writer, f.snapshot, NOW + 299999);
  expect(v.manifest.verification?.expiresAt).toBe(new Date(NOW + 300000).toISOString());
  const writer = renderWriterManifest({
    ...f.manifest,
    window: { startsAt: f.manifest.window.startsAt, endsAt: new Date(NOW + 100000).toISOString() },
  });
  expect(renderVerifierManifest(writer, f.snapshot, NOW).manifest.verification?.expiresAt).toBe(
    new Date(NOW + 100000).toISOString(),
  );
});
test('forged six-minute pinned snapshot and unrelated manifest pair fail', () => {
  const f = pair(),
    m: Manifest = JSON.parse(JSON.stringify(f.verifier.manifest));
  m.verification!.expiresAt = new Date(NOW + 300001).toISOString();
  let raw = canonical(m);
  expect(() => bindManifest(raw, digest(raw))).toThrow('SNAPSHOT_FIVE_MINUTE_LIMIT');
  m.verification!.expiresAt = new Date(NOW + 300000).toISOString();
  m.customerName = 'other';
  raw = canonical(m);
  expect(() => validateManifestPair(f.writer, bindManifest(raw, digest(raw)))).toThrow('MANIFEST_PAIR_MISMATCH');
});
test('published-mode runtime accepts actual numeric version, never alias or latest; old fixed mode stays exact', () => {
  const f = pair(),
    base = functionArn('writer');
  checkInvocation(f.writer, 'writer', { functionVersion: '37', invokedFunctionArn: base + ':37' });
  for (const [n, arn] of [
    ['$LATEST', base],
    ['37', base + ':current'],
    ['38', base + ':37'],
    ['0', base + ':0'],
  ])
    expect(() => checkInvocation(f.writer, 'writer', { functionVersion: n!, invokedFunctionArn: arn! })).toThrow(
      'PUBLISHED_VERSION_REQUIRED',
    );
  const raw = canonical({ ...f.writer.manifest, writerVersion: '1' }),
    old = bindManifest(raw, digest(raw));
  expect(() => checkInvocation(old, 'writer', { functionVersion: '2', invokedFunctionArn: base + ':2' })).toThrow();
});
test('deterministic ZIP contains the exact canonical manifest and rejects corruption or wrong manifest metadata', () => {
  const f = pair(),
    a = packageLambda(Buffer.from('export const handler=()=>{};'), f.writer),
    b = packageLambda(Buffer.from('export const handler=()=>{};'), f.writer);
  expect(a.bytes.equals(b.bytes)).toBe(true);
  expect(verifyLambdaPackage(a.bytes, f.writer).manifestHash).toBe(f.writer.hash);
  const bad = Buffer.from(a.bytes);
  bad[50] ^= 1;
  expect(() => verifyLambdaPackage(bad, f.writer)).toThrow();
  expect(() => verifyLambdaPackage(a.bytes, f.verifier)).toThrow('ZIP_MANIFEST_MISMATCH');
});
test('phase A cannot write CONTROL; phase B has exactly one UUID LeadingKeys with Null guard', () => {
  const f = pair(),
    a = writerPolicy('A'),
    b = writerPolicy('B', f.snapshot.binding.deviceId);
  expect(
    a.Statement.some(
      (s) => s.Effect === 'Allow' && (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('dynamodb:PutItem'),
    ),
  ).toBe(false);
  const put = b.Statement.find((s) => s.Sid === 'PutOnlyApprovedServerAssignedDevice')!;
  expect(put.Condition).toEqual({
    'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['DEVICE#' + f.snapshot.binding.deviceId] },
    Null: { 'dynamodb:LeadingKeys': 'false' },
  });
  for (const p of [a, b, writerBoundary(), verifierPolicy()])
    expect(JSON.stringify(p)).not.toContain(TARGET.payloadTable);
  expect(() => writerPolicy('B', 'DEVICE#img21-*')).toThrow();
  expect(() => writerPolicy('A', f.snapshot.binding.deviceId)).toThrow();
});
test('runtime and control-plane policies preserve the previously reviewed eight draft constraints', () => {
  const f = pair(),
    read = (p: string) =>
      JSON.parse(
        readFileSync(
          new URL(
            '../../../docs/audit/evidence/2026-11-08-device-image-minimal-closure/iam/' + p + '.template.json',
            import.meta.url,
          ),
          'utf8',
        ).replaceAll('{{BOUND_DEVICE_UUID}}', f.snapshot.binding.deviceId),
      );
  for (const [name, p] of [
    ['writer-phase-a', writerPolicy('A')],
    ['writer-phase-b', writerPolicy('B', f.snapshot.binding.deviceId)],
    ['writer-boundary', writerBoundary()],
    ['verifier', verifierPolicy()],
    ['verifier-boundary', verifierPolicy()],
    ['runtime-trust', runtimeTrust()],
    ['deployer-delta', controlPlaneDelta()],
  ] as const)
    expect(jsonHash(p), name).toBe(jsonHash(read(name)));
  for (const kind of ['writer', 'verifier'] as const)
    expect(
      controlPlaneDelta().Statement.find((s) => s.Resource === roleArn(kind) && s.Effect === 'Deny'),
    ).toBeDefined();
});
test('review-only patch preserves every old statement and rejects double application', () => {
  const original = JSON.parse(
      readFileSync(new URL('../../../infra/iam/FDP-DeploymentBoundary.json', import.meta.url), 'utf8'),
    ),
    patched = reviewedControlPlanePatch(original);
  expect(patched.Statement.slice(0, original.Statement.length)).toEqual(original.Statement);
  expect(() => reviewedControlPlanePatch(patched)).toThrow('DELTA_ALREADY_PRESENT');
});
test('budget adds only one connection and preserves operational/idle reserves', () => {
  const f = pair(),
    b = checkBudget(f.budget, NOW);
  expect(b).toMatchObject({
    ordinarySlots: 70,
    existingConnections: 46,
    writerConnections: 1,
    operationalReserve: 8,
    idleOverlapReserve: 10,
    remaining: 5,
  });
  expect(() => checkBudget({ ...f.budget, otherClients: 6 }, NOW)).toThrow('WRITER_CONNECTION_BUDGET_EXCEEDED');
  expect(() => checkBudget({ ...f.budget, operationalReserve: 7 }, NOW)).toThrow('RESERVES_MUST_BE_PRESERVED');
  expect(() => checkBudget({ ...f.budget, functions: f.budget.functions.slice(1) }, NOW)).toThrow();
  expect(() => checkBudget(f.budget, NOW + 300001)).toThrow();
});
test('network must import two subnets/one SG from fresh explicit input, never use lookup', () => {
  const f = pair();
  checkNetwork(f.network, NOW);
  expect(() => checkNetwork({ ...f.network, subnetIds: [f.network.subnetIds[0]!] }, NOW)).toThrow();
  expect(() => checkNetwork(f.network, NOW + 300001)).toThrow();
});
function synth(phase: 'A' | 'B', modify?: (p: ToolStackProps) => void) {
  const f = pair(),
    dir = mkdtempSync(join(tmpdir(), 'img21-iac-'));
  const asset = (kind: Kind, bound: typeof f.writer) => {
    const a = packageLambda(Buffer.from('export const handler=()=>{};'), bound),
      path = join(dir, kind + '.zip');
    writeFileSync(path, a.bytes);
    return { path, sha256: a.sha256, codeSha256: a.codeSha256, manifestHash: bound.hash };
  };
  const writerAsset = asset('writer', f.writer),
    p: ToolStackProps = {
      writer: f.writer,
      writerAsset,
      network: f.network,
      budget: f.budget,
      now: NOW,
      phase,
      analyticsReporting: false,
      ...(phase === 'B'
        ? {
            verifier: f.verifier,
            verifierAsset: asset('verifier', f.verifier),
            deviceId: f.snapshot.binding.deviceId,
            previousWriterAssetSha256: writerAsset.sha256,
            bindingReceipt: {
              runId: f.writer.manifest.runId,
              manifestHash: f.writer.hash,
              status: 'COMMITTED',
              action: 'BIND_DEVICE',
              operationId: 'a'.repeat(64),
              requestHash: 'b'.repeat(64),
              binding: f.snapshot.binding,
              sourceRef: 'LOCAL_FIXTURE_ONLY',
            },
          }
        : {}),
    };
  try {
    modify?.(p);
    const app = new App({ autoSynth: false, outdir: join(dir, 'out') }),
      s = new Img21ToolsStack(app, 'Img21Tools', p);
    return Template.fromStack(s).toJSON();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('independent stack has no public/trigger/network/DB resources; A writer only and B fixed pair', () => {
  const a = synth('A'),
    b = synth('B'),
    types = (t: any) => Object.values(t.Resources).map((r: any) => r.Type);
  expect(types(a).filter((t: string) => t === 'AWS::Lambda::Function')).toHaveLength(1);
  expect(types(b).filter((t: string) => t === 'AWS::Lambda::Function')).toHaveLength(2);
  expect(
    types(b).every((t: string) =>
      [
        'AWS::Lambda::Function',
        'AWS::Lambda::Version',
        'AWS::Lambda::EventInvokeConfig',
        'AWS::IAM::Role',
        'AWS::IAM::ManagedPolicy',
        'AWS::Logs::LogGroup',
      ].includes(t),
    ),
  ).toBe(true);
  for (const r of Object.values(b.Resources) as any[]) {
    expect(r.DeletionPolicy).toBe('Retain');
    if (r.Type === 'AWS::Lambda::Function') {
      expect(r.Properties.ReservedConcurrentExecutions).toBe(1);
      expect(r.Properties.RuntimeManagementConfig).toEqual({ UpdateRuntimeOn: 'FunctionUpdate' });
      if (r.Properties.FunctionName.endsWith('license-verifier')) {
        expect(r.Properties.VpcConfig).toBeUndefined();
        expect(Object.keys(r.Properties.Environment.Variables)).toEqual(['IMG21_MANIFEST_SHA256']);
      }
    }
  }
  const writerVersions = (t: any) =>
    Object.entries(t.Resources)
      .filter(([k, v]: any) => v.Type === 'AWS::Lambda::Version' && k.startsWith('writer'))
      .map(([k, v]) => [k, v]);
  expect(writerVersions(a)).toEqual(writerVersions(b));
  expect(
    Object.values(b.Resources)
      .filter((r: any) => r.Type === 'AWS::Lambda::Version')
      .every((r: any) => r.Properties.CodeSha256),
  ).toBe(true);
});
for (const [label, mutate] of [
  [
    'different UUID',
    (p: ToolStackProps) => {
      p.deviceId = '99999999-9999-4999-8999-999999999999';
    },
  ],
  [
    'missing binding receipt',
    (p: ToolStackProps) => {
      delete p.bindingReceipt;
    },
  ],
  [
    'changed Writer ZIP',
    (p: ToolStackProps) => {
      p.previousWriterAssetSha256 = '0'.repeat(64);
    },
  ],
  [
    'stale snapshot',
    (p: ToolStackProps) => {
      p.now = NOW + 300000;
    },
  ],
  [
    'missing verifier',
    (p: ToolStackProps) => {
      delete p.verifier;
      delete p.verifierAsset;
    },
  ],
  [
    'forged asset manifest',
    (p: ToolStackProps) => {
      p.writerAsset.manifestHash = 'f'.repeat(64);
    },
  ],
] as const)
  test(`phase B refuses ${label}`, () => expect(() => synth('B', mutate)).toThrow());
test('binding evidence must point at committed BIND_DEVICE receipt from the exact Writer', () => {
  const f = pair();
  expect(() =>
    validatePhaseB(
      f.writer,
      {
        runId: f.writer.manifest.runId,
        manifestHash: '0'.repeat(64),
        status: 'COMMITTED',
        action: 'BIND_DEVICE',
        operationId: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        binding: f.snapshot.binding,
        sourceRef: 'local',
      },
      f.snapshot.binding.deviceId,
      'a'.repeat(64),
      'a'.repeat(64),
    ),
  ).toThrow();
});
for (const kind of ['writer', 'verifier'] as const)
  test(`${kind} publication binds observed numeric version, code, env, mutable roles and runtime`, () => {
    const f = observation(kind),
      ticket = validatePublished(f.expected, f.o, NOW);
    expect(ticket.qualifiedArn).toBe(functionArn(kind) + ':37');
    expect(ticket.manifestHash).toBe(f.bound.hash);
    expect(Date.parse(ticket.freshUntil) - NOW).toBe(15000);
  });
for (const [label, mutate] of [
  [
    'version',
    (o: PublishedObservation) => {
      o.configuration.Version = '38';
    },
  ],
  [
    'latest',
    (o: PublishedObservation) => {
      o.qualifiedArn = functionArn('writer') + ':$LATEST';
    },
  ],
  [
    'code',
    (o: PublishedObservation) => {
      o.configuration.CodeSha256 = 'other';
    },
  ],
  [
    'manifest env',
    (o: PublishedObservation) => {
      o.configuration.EnvironmentHash = 'f'.repeat(64);
    },
  ],
  [
    'runtime auto',
    (o: PublishedObservation) => {
      o.runtime.UpdateRuntimeOn = 'Auto';
    },
  ],
  [
    'role boundary',
    (o: PublishedObservation) => {
      o.role.boundaryArn = 'other';
    },
  ],
  [
    'extra role policy',
    (o: PublishedObservation) => {
      o.role.attachedPolicyArns.push('arbitrary');
    },
  ],
  [
    'inline policy',
    (o: PublishedObservation) => {
      o.role.inline = { ...o.role.inline, Statement: [] };
    },
  ],
  [
    'network',
    (o: PublishedObservation) => {
      o.configuration.VpcConfig.SubnetIds = ['foreign'];
    },
  ],
  [
    'concurrency',
    (o: PublishedObservation) => {
      o.concurrency = 2;
    },
  ],
  [
    'account',
    (o: PublishedObservation) => {
      o.accountId = '000000000000';
    },
  ],
  [
    'unready',
    (o: PublishedObservation) => {
      o.configuration.State = 'Pending';
    },
  ],
] as const)
  test(`publication rejects ${label} drift before grant generation`, () => {
    const f = observation();
    mutate(f.o);
    expect(() => validatePublished(f.expected, f.o, NOW)).toThrow();
  });
test('old observation, stale snapshot and delayed publication cannot receive invoke grant', () => {
  const a = observation();
  expect(() => validatePublished(a.expected, a.o, NOW + 15000)).toThrow();
  const b = observation('verifier');
  b.o.capturedAt = new Date(NOW + 300000).toISOString();
  expect(() => validatePublished(b.expected, b.o, NOW + 300000)).toThrow('SNAPSHOT_EXPIRED_BEFORE_PUBLICATION');
  const w = observation(),
    v = observation('verifier'),
    wt = validatePublished(w.expected, w.o, NOW),
    vt = validatePublished(v.expected, v.o, NOW);
  const grant = invokePolicy(wt, vt, w.writer, NOW, v.verifier);
  expect(grant.Statement.map((s) => s.Resource)).toEqual([
    [functionArn('writer') + ':37'],
    [functionArn('verifier') + ':37'],
  ]);
  expect(grant.Statement[0]!.Condition?.DateLessThan).toEqual({ 'aws:CurrentTime': w.writer.manifest.window.endsAt });
  expect(grant.Statement[1]!.Condition?.DateLessThan).toEqual({
    'aws:CurrentTime': new Date(NOW + 300000).toISOString(),
  });
  expect(() => invokePolicy(wt, vt, w.writer, NOW + 15000, v.verifier)).toThrow();
  expect(() =>
    invokePolicy(
      wt,
      { ...vt, qualifiedArn: 'arn:aws:lambda:ap-southeast-1:065986019555:function:other:1' },
      w.writer,
      NOW,
      v.verifier,
    ),
  ).toThrow();
});
test('readonly observer invokes only exact read commands via injected port and strips URLs/environment values', async () => {
  const f = observation(),
    calls: string[][] = [],
    cfg: Record<string, any> = {
      ...f.o.configuration,
      Environment: { Variables: { IMG21_MANIFEST_SHA256: f.bound.hash, UNEXPECTED: 'do-not-persist' } },
    };
  delete cfg.EnvironmentHash;
  const exec = (args: string[]) => {
    calls.push(args);
    switch (args[1]) {
      case 'get-caller-identity':
        return { Account: TARGET.accountId, Arn: f.o.principalArn };
      case 'get-function':
        return { Configuration: cfg, Code: { Location: 'SIGNED_URL_DO_NOT_PERSIST' } };
      case 'get-function-concurrency':
        return { ReservedConcurrentExecutions: 1 };
      case 'get-runtime-management-config':
        return f.o.runtime;
      case 'get-role':
        return {
          Role: {
            Arn: roleArn('writer'),
            PermissionsBoundary: { PermissionsBoundaryArn: boundaryArn('writer') },
            AssumeRolePolicyDocument: runtimeTrust(),
          },
        };
      case 'list-role-policies':
        return { PolicyNames: ['IMG21Runtime'] };
      case 'list-attached-role-policies':
        return { AttachedPolicies: [] };
      case 'get-role-policy':
        return { PolicyDocument: encodeURIComponent(JSON.stringify(f.expected.policy)) };
      case 'get-policy':
        return args[0] === 'lambda' ? { PolicyAbsent: true } : { Policy: { DefaultVersionId: 'v1' } };
      case 'get-function-event-invoke-config':
        return f.o.asyncConfig;
      case 'get-policy-version':
        return { PolicyVersion: { Document: f.expected.boundary } };
      default:
        throw Error('NOT_READONLY');
    }
  };
  const o = await createReadOnlyPublicationObserver('fdp-test-readonlyops', exec)(
    'writer',
    f.o.qualifiedArn,
    () => NOW,
  );
  expect(calls).toHaveLength(13);
  expect(calls.every((a) => a.includes('--profile') && a.includes(TARGET.region))).toBe(true);
  expect(JSON.stringify(o)).not.toContain('SIGNED_URL');
  expect(JSON.stringify(o)).not.toContain('do-not-persist');
  expect(() => validatePublished(f.expected, o, NOW)).toThrow('PUBLISHED_CONFIGURATION_DRIFT');
});
test('safe configuration never retains unexpected environment values; observer refuses wrong namespace/account and raw errors', async () => {
  expect(
    JSON.stringify(
      safeConfiguration({ Environment: { Variables: { PASSWORD: 'sensitive' } }, Description: 'sensitive' }),
    ),
  ).not.toContain('sensitive');
  expect(() => createReadOnlyPublicationObserver('production')).toThrow();
  let calls = 0;
  const observe = createReadOnlyPublicationObserver('fdp-test-readonlyops', () => {
    calls++;
    throw Error('raw-secret-text');
  });
  await expect(observe('writer', functionArn('writer') + ':alias', () => NOW)).rejects.toThrow(
    'EXACT_NUMERIC_VERSION_REQUIRED',
  );
  expect(calls).toBe(0);
  await expect(observe('writer', functionArn('writer') + ':1', () => NOW)).rejects.toThrow(
    'READ_ONLY_OBSERVATION_UNAVAILABLE',
  );
});

for (const [label, mutate] of [
  [
    'injected layer',
    (o: PublishedObservation) => {
      o.configuration.Layers = [{ Arn: 'injected' }];
    },
  ],
  [
    'filesystem code',
    (o: PublishedObservation) => {
      o.configuration.FileSystemConfigs = [{ Arn: 'injected' }];
    },
  ],
  [
    'asynchronous retries',
    (o: PublishedObservation) => {
      o.asyncConfig.MaximumRetryAttempts = 2;
    },
  ],
  [
    'resource policy',
    (o: PublishedObservation) => {
      o.resourcePoliciesAbsent = false;
    },
  ],
  [
    'snapshot runtime',
    (o: PublishedObservation) => {
      o.configuration.SnapStart = { ApplyOn: 'PublishedVersions' };
    },
  ],
  [
    'image package',
    (o: PublishedObservation) => {
      o.configuration.PackageType = 'Image';
    },
  ],
  [
    'unexpected environment KMS',
    (o: PublishedObservation) => {
      o.configuration.KMSKeyArn = 'changed';
    },
  ],
] as const)
  test(`published ZIP hash alone cannot approve ${label}`, () => {
    const f = observation();
    mutate(f.o);
    expect(() => validatePublished(f.expected, f.o, NOW)).toThrow();
  });
test('snapshot source and exact two manifests have a separate reproducible audit binding', () => {
  const f = pair(),
    r = manifestPairReceipt(f.writer, f.verifier, f.snapshot);
  expect(r.writerManifestHash).toBe(f.writer.hash);
  expect(r.snapshotProofHash).toBe(digest(canonical(f.snapshot)));
  expect(() => manifestPairReceipt(f.writer, f.verifier, { ...f.snapshot, snapshotEtag: '0'.repeat(64) })).toThrow(
    'SNAPSHOT_RENDERING_MISMATCH',
  );
});
test('publication coordinator rechecks its real clock after async reads and never applies policies', async () => {
  const w = observation(),
    v = observation('verifier');
  let time = NOW;
  const observe = async (kind: Kind) => (kind === 'writer' ? w.o : v.o);
  const prepared = await prepareInvokePolicy(
    w.expected,
    w.o.qualifiedArn,
    v.expected,
    v.o.qualifiedArn,
    observe,
    () => time,
  );
  expect(prepared.applied).toBe(false);
  expect(prepared.policy.Statement).toHaveLength(2);
  const slow = async (kind: Kind) => {
    time = NOW + 300000;
    return observe(kind);
  };
  await expect(
    prepareInvokePolicy(w.expected, w.o.qualifiedArn, v.expected, v.o.qualifiedArn, slow, () => time),
  ).rejects.toThrow();
});
