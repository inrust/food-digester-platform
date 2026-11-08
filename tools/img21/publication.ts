import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TARGET, checkWindow, jsonHash, requireThat, Rejected } from './contracts.js';
import type { BoundManifest } from './contracts.js';
import { validateManifestPair } from './manifests.js';
import { boundaryArn, functionArn, roleArn, roleName, runtimeTrust } from './policies.js';
import type { Policy } from './policies.js';
import type { Network, ToolAsset } from './infra.js';
export type Kind = 'writer' | 'verifier';
export interface PublishedObservation {
  capturedAt: string;
  accountId: string;
  principalArn: string;
  qualifiedArn: string;
  configuration: Record<string, any>;
  concurrency: number;
  runtime: { UpdateRuntimeOn: string; RuntimeVersionArn: string };
  asyncConfig: { MaximumRetryAttempts: number; MaximumEventAgeInSeconds: number; DestinationConfig?: any };
  resourcePoliciesAbsent: boolean;
  role: {
    arn: string;
    boundaryArn: string;
    trust: Policy;
    inlineNames: string[];
    attachedPolicyArns: string[];
    inline: Policy;
    boundary: Policy;
  };
}
export interface ExpectedPublication {
  kind: Kind;
  bound: BoundManifest;
  asset: ToolAsset;
  policy: Policy;
  boundary: Policy;
  network: Network;
}
export interface PublicationTicket {
  kind: Kind;
  runId: string;
  manifestHash: string;
  applicationCommit: string;
  toolCommit: string;
  qualifiedArn: string;
  codeSha256: string;
  configurationHash: string;
  policyHash: string;
  boundaryHash: string;
  runtimeVersionArn: string;
  capturedAt: string;
  freshUntil: string;
  snapshotExpiresAt: string | null;
  principalArn: string;
}
export function validatePublished(
  expected: ExpectedPublication,
  o: PublishedObservation,
  now: number,
): PublicationTicket {
  const { kind, bound, asset } = expected,
    m = bound.manifest;
  checkWindow(bound, now);
  const captured = Date.parse(o.capturedAt),
    base = functionArn(kind),
    v = o.qualifiedArn.slice(base.length + 1),
    cfg = o.configuration;
  requireThat(
    Number.isFinite(captured) &&
      captured <= now &&
      now - captured < 15000 &&
      o.accountId === TARGET.accountId &&
      /^arn:aws:(iam|sts)::065986019555:/u.test(o.principalArn),
    'FRESH_TARGET_IDENTITY_REQUIRED',
  );
  requireThat(
    o.qualifiedArn === `${base}:${v}` &&
      /^[1-9][0-9]*$/u.test(v) &&
      cfg.Version === v &&
      [base, o.qualifiedArn].includes(cfg.FunctionArn) &&
      cfg.CodeSha256 === asset.codeSha256 &&
      asset.manifestHash === bound.hash,
    'PUBLISHED_CODE_VERSION_DRIFT',
  );
  requireThat(
    m.writerVersion === 'PUBLISHED' && m.verifierVersion === 'PUBLISHED',
    'POST_PUBLISH_BINDING_MODE_REQUIRED',
  );
  const env = {
    IMG21_MANIFEST_SHA256: bound.hash,
    ...(kind === 'writer'
      ? {
          LIVE_IMAGE_CONTROL_TABLE: TARGET.controlTable,
          LIVE_IMAGE_PAYLOAD_TABLE: TARGET.payloadTable,
          FDP_DB_POOL_MAX: '1',
        }
      : {}),
  };
  requireThat(
    cfg.EnvironmentHash === jsonHash(env) &&
      cfg.Runtime === 'nodejs24.x' &&
      JSON.stringify(cfg.Architectures) === JSON.stringify(['arm64']) &&
      cfg.Handler === 'index.handler' &&
      cfg.Timeout === 30 &&
      cfg.MemorySize === (kind === 'writer' ? 512 : 256) &&
      cfg.State === 'Active' &&
      cfg.LastUpdateStatus === 'Successful' &&
      cfg.Role === roleArn(kind) &&
      cfg.PackageType === 'Zip' &&
      !cfg.Layers?.length &&
      !cfg.FileSystemConfigs?.length &&
      !cfg.DeadLetterConfig?.TargetArn &&
      !cfg.KMSKeyArn &&
      cfg.SnapStart?.ApplyOn !== 'PublishedVersions' &&
      !cfg.VpcConfig?.Ipv6AllowedForDualStack &&
      o.concurrency === 1 &&
      typeof cfg.RevisionId === 'string' &&
      cfg.RevisionId.length > 0 &&
      cfg.LoggingConfig?.LogGroup ===
        `/aws/lambda/fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}` &&
      cfg.LoggingConfig?.LogFormat === 'JSON',
    'PUBLISHED_CONFIGURATION_DRIFT',
  );
  if (kind === 'writer')
    requireThat(
      cfg.VpcConfig?.VpcId === expected.network.vpcId &&
        jsonHash([...(cfg.VpcConfig.SubnetIds ?? [])].sort()) === jsonHash([...expected.network.subnetIds].sort()) &&
        jsonHash([...(cfg.VpcConfig.SecurityGroupIds ?? [])].sort()) ===
          jsonHash([...expected.network.securityGroupIds].sort()),
      'WRITER_NETWORK_DRIFT',
    );
  else
    requireThat(
      !cfg.VpcConfig?.VpcId && !cfg.VpcConfig?.SubnetIds?.length && !cfg.VpcConfig?.SecurityGroupIds?.length,
      'VERIFIER_MUST_NOT_HAVE_VPC',
    );
  requireThat(
    o.role.arn === roleArn(kind) &&
      o.role.boundaryArn === boundaryArn(kind) &&
      jsonHash(o.role.trust) === jsonHash(runtimeTrust()) &&
      jsonHash(o.role.inlineNames) === jsonHash(['IMG21Runtime']) &&
      o.role.attachedPolicyArns.length === 0 &&
      jsonHash(o.role.inline) === jsonHash(expected.policy) &&
      jsonHash(o.role.boundary) === jsonHash(expected.boundary),
    'MUTABLE_ROLE_POLICY_DRIFT',
  );
  requireThat(
    o.runtime.UpdateRuntimeOn === 'FunctionUpdate' &&
      /^arn:aws:lambda:ap-southeast-1::runtime:[a-f0-9]{64}$/u.test(o.runtime.RuntimeVersionArn),
    'RUNTIME_VERSION_NOT_BOUND',
  );
  requireThat(
    o.asyncConfig.MaximumRetryAttempts === 0 &&
      o.asyncConfig.MaximumEventAgeInSeconds === 60 &&
      !o.asyncConfig.DestinationConfig?.OnSuccess?.Destination &&
      !o.asyncConfig.DestinationConfig?.OnFailure?.Destination &&
      o.resourcePoliciesAbsent,
    'PRIVATE_SYNCHRONOUS_CHANNEL_REQUIRED',
  );
  let expires = Date.parse(m.window.endsAt);
  if (kind === 'verifier') {
    const s = m.verification;
    requireThat(m.verifierBinding && s?.observedAt, 'FROZEN_SNAPSHOT_REQUIRED');
    const observed = Date.parse(s.observedAt);
    expires = Math.min(expires, Date.parse(s.expiresAt));
    requireThat(
      observed <= now && expires <= observed + 300000 && now < expires,
      'SNAPSHOT_EXPIRED_BEFORE_PUBLICATION',
    );
  }
  return {
    kind,
    runId: m.runId,
    manifestHash: bound.hash,
    applicationCommit: m.applicationCommit,
    toolCommit: m.toolCommit,
    qualifiedArn: o.qualifiedArn,
    codeSha256: cfg.CodeSha256,
    configurationHash: jsonHash(cfg),
    policyHash: jsonHash(o.role.inline),
    boundaryHash: jsonHash(o.role.boundary),
    runtimeVersionArn: o.runtime.RuntimeVersionArn,
    capturedAt: o.capturedAt,
    freshUntil: new Date(Math.min(expires, captured + 15000)).toISOString(),
    snapshotExpiresAt: kind === 'verifier' ? m.verification!.expiresAt : null,
    principalArn: o.principalArn,
  };
}
export function invokePolicy(
  writer: PublicationTicket,
  verifier: PublicationTicket | undefined,
  bound: BoundManifest,
  now: number,
  verifierBound?: BoundManifest,
): Policy {
  const tickets = verifier ? [writer, verifier] : [writer];
  if (verifier) {
    requireThat(
      verifierBound &&
        verifier.manifestHash === verifierBound.hash &&
        verifier.snapshotExpiresAt === verifierBound.manifest.verification?.expiresAt,
      'VERIFIER_TICKET_MANIFEST_REQUIRED',
    );
    validateManifestPair(bound, verifierBound);
  }
  requireThat(
    tickets.every((t) => new RegExp('^' + functionArn(t.kind) + ':[1-9][0-9]*$', 'u').test(t.qualifiedArn)),
    'NUMERIC_TICKET_ARNS_REQUIRED',
  );
  requireThat(
    writer.kind === 'writer' &&
      (!verifier || verifier.kind === 'verifier') &&
      tickets.every(
        (t) =>
          t.runId === bound.manifest.runId &&
          t.applicationCommit === bound.manifest.applicationCommit &&
          t.toolCommit === bound.manifest.toolCommit &&
          now < Date.parse(t.freshUntil) &&
          Date.parse(t.capturedAt) <= now,
      ) &&
      writer.manifestHash === bound.hash,
    'FRESH_PUBLICATION_TICKETS_REQUIRED',
  );
  checkWindow(bound, now);
  return {
    Version: '2012-10-17',
    Statement: tickets.map((t) => ({
      Sid: t.kind === 'writer' ? 'InvokeObservedWriterVersion' : 'InvokeObservedVerifierVersion',
      Effect: 'Allow',
      Action: ['lambda:InvokeFunction'],
      Resource: [t.qualifiedArn],
      Condition: {
        DateGreaterThanEquals: { 'aws:CurrentTime': bound.manifest.window.startsAt },
        DateLessThan: {
          'aws:CurrentTime':
            t.kind === 'verifier'
              ? new Date(
                  Math.min(Date.parse(bound.manifest.window.endsAt), Date.parse(t.snapshotExpiresAt!)),
                ).toISOString()
              : bound.manifest.window.endsAt,
        },
      },
    })),
  };
}
/** Authorized coordinator only. No target action is wired to the local synth entry. */
const execAsync = promisify(execFile);
async function defaultRead(args: string[]) {
  try {
    const { stdout } = await execAsync('aws', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    if (
      args[0] === 'lambda' &&
      args[1] === 'get-policy' &&
      /ResourceNotFoundException/u.test(String((e as { stderr?: unknown }).stderr ?? ''))
    )
      return { PolicyAbsent: true };
    throw new Rejected('READ_ONLY_OBSERVATION_UNAVAILABLE');
  }
}
export function createReadOnlyPublicationObserver(
  profile: string,
  execute: (args: string[]) => any | Promise<any> = defaultRead,
) {
  requireThat(/^fdp-test-[a-z0-9-]+$/u.test(profile), 'ISOLATED_READONLY_PROFILE_REQUIRED');
  const read = async (service: string, action: string, args: string[]) => {
    try {
      return await execute([
        service,
        action,
        ...args,
        '--profile',
        profile,
        '--region',
        TARGET.region,
        '--output',
        'json',
        '--no-cli-pager',
      ]);
    } catch {
      throw new Rejected('READ_ONLY_OBSERVATION_UNAVAILABLE');
    }
  };
  return async (kind: Kind, qualifiedArn: string, now: () => number): Promise<PublishedObservation> => {
    const base = functionArn(kind),
      version = qualifiedArn.slice(base.length + 1);
    requireThat(
      qualifiedArn === `${base}:${version}` && /^[1-9][0-9]*$/u.test(version),
      'EXACT_NUMERIC_VERSION_REQUIRED',
    );
    const capturedAt = new Date(now()).toISOString(),
      identity = await read('sts', 'get-caller-identity', []);
    requireThat(identity.Account === TARGET.accountId, 'WRONG_TARGET_ACCOUNT');
    const versionArgs = ['--function-name', base, '--qualifier', version],
      roleArgs = ['--role-name', roleName(kind)];
    const [
      fn,
      concurrency,
      runtime,
      roleData,
      names,
      attached,
      inlineData,
      policyData,
      asyncConfig,
      basePolicy,
      versionPolicy,
    ] = await Promise.all([
      read('lambda', 'get-function', versionArgs),
      read('lambda', 'get-function-concurrency', ['--function-name', base]),
      read('lambda', 'get-runtime-management-config', versionArgs),
      read('iam', 'get-role', roleArgs),
      read('iam', 'list-role-policies', roleArgs),
      read('iam', 'list-attached-role-policies', roleArgs),
      read('iam', 'get-role-policy', [...roleArgs, '--policy-name', 'IMG21Runtime']),
      read('iam', 'get-policy', ['--policy-arn', boundaryArn(kind)]),
      read('lambda', 'get-function-event-invoke-config', versionArgs),
      read('lambda', 'get-policy', ['--function-name', base]),
      read('lambda', 'get-policy', versionArgs),
    ]);
    requireThat(!names.IsTruncated && !attached.IsTruncated, 'POLICY_PAGINATION_REQUIRED');
    const boundaryData = await read('iam', 'get-policy-version', [
        '--policy-arn',
        boundaryArn(kind),
        '--version-id',
        policyData.Policy.DefaultVersionId,
      ]),
      role = roleData.Role;
    const decode = (p: any) => (typeof p === 'string' ? JSON.parse(decodeURIComponent(p)) : p);
    return {
      capturedAt,
      accountId: identity.Account,
      principalArn: identity.Arn,
      qualifiedArn,
      configuration: safeConfiguration(fn.Configuration),
      concurrency: concurrency.ReservedConcurrentExecutions,
      runtime,
      asyncConfig,
      resourcePoliciesAbsent: basePolicy.PolicyAbsent === true && versionPolicy.PolicyAbsent === true,
      role: {
        arn: role.Arn,
        boundaryArn: role.PermissionsBoundary?.PermissionsBoundaryArn,
        trust: decode(role.AssumeRolePolicyDocument),
        inlineNames: names.PolicyNames.sort(),
        attachedPolicyArns: attached.AttachedPolicies.map((p: any) => p.PolicyArn).sort(),
        inline: decode(inlineData.PolicyDocument),
        boundary: decode(boundaryData.PolicyVersion.Document),
      },
    };
  };
}
export async function prepareInvokePolicy(
  writer: ExpectedPublication,
  writerArn: string,
  verifier: ExpectedPublication | undefined,
  verifierArn: string | undefined,
  observe: ReturnType<typeof createReadOnlyPublicationObserver>,
  now: () => number = Date.now,
) {
  requireThat(
    writer.kind === 'writer' && !!verifier === !!verifierArn && (!verifier || verifier.kind === 'verifier'),
    'PUBLICATION_PAIR_REQUIRED',
  );
  if (verifier) validateManifestPair(writer.bound, verifier.bound);
  const observations = await Promise.all([
    observe('writer', writerArn, now),
    ...(verifier ? [observe('verifier', verifierArn!, now)] : []),
  ]);
  const w = validatePublished(writer, observations[0]!, now()),
    v = verifier ? validatePublished(verifier, observations[1]!, now()) : undefined;
  return {
    writerTicket: w,
    verifierTicket: v,
    policy: invokePolicy(w, v, writer.bound, now(), verifier?.bound),
    applied: false,
  };
}
/** Do not persist signed download URLs, descriptions, or plaintext environment values. */
export function safeConfiguration(cfg: Record<string, any>) {
  const selected: Record<string, any> = {};
  for (const key of [
    'PackageType',
    'Layers',
    'FileSystemConfigs',
    'DeadLetterConfig',
    'KMSKeyArn',
    'SnapStart',
    'Version',
    'FunctionArn',
    'CodeSha256',
    'Runtime',
    'Architectures',
    'Handler',
    'Timeout',
    'MemorySize',
    'State',
    'LastUpdateStatus',
    'Role',
    'RevisionId',
    'LoggingConfig',
    'VpcConfig',
  ])
    if (cfg[key] !== undefined) selected[key] = cfg[key];
  selected.EnvironmentHash = jsonHash(cfg.Environment?.Variables ?? {});
  return selected;
}
