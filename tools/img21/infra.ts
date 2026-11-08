/** Dedicated tool stack. L1/imported identifiers only: no lookup, deploy, context fetch or app-stack mutation. */
import { Stack, CfnOutput, RemovalPolicy, AssetHashType } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { CfnRole, CfnManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnFunction, CfnVersion, CfnEventInvokeConfig } from 'aws-cdk-lib/aws-lambda';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { readFileSync } from 'node:fs';
import { TARGET, digest, requireThat, jsonHash, checkWindow } from './contracts.js';
import type { BoundManifest } from './contracts.js';
import { functionArn, roleName, runtimeTrust, writerBoundary, writerPolicy, verifierPolicy } from './policies.js';
import type { Phase } from './policies.js';
import { validateManifestPair } from './manifests.js';
import { verifyLambdaPackage } from './archive.js';
import { validatePhaseB } from './phase-b.js';
import type { BindingReceipt } from './phase-b.js';
import { DATABASE_FUNCTION_CONCURRENCY } from '../../infra/src/database-capacity.js';
export interface Budget {
  sourceRef: string;
  observedAt: string;
  maxConnections: number;
  superuserReserved: number;
  reserved: number;
  rdsReserved: number;
  operationalReserve: number;
  idleOverlapReserve: number;
  otherClients: number;
  functions: Array<{ name: string; reservedConcurrency: number; poolMax: number }>;
}
export function checkBudget(b: Budget, now: number) {
  const expected = Object.keys(DATABASE_FUNCTION_CONCURRENCY).sort();
  requireThat(
    typeof b.sourceRef === 'string' &&
      b.sourceRef.length > 0 &&
      Number.isFinite(now) &&
      Number.isFinite(Date.parse(b.observedAt)) &&
      Date.parse(b.observedAt) <= now &&
      now - Date.parse(b.observedAt) <= 300000,
    'FRESH_BUDGET_REQUIRED',
  );
  requireThat(
    [
      b.maxConnections,
      b.superuserReserved,
      b.reserved,
      b.rdsReserved,
      b.operationalReserve,
      b.idleOverlapReserve,
      b.otherClients,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      b.operationalReserve >= 8 &&
      b.idleOverlapReserve >= 10,
    'RESERVES_MUST_BE_PRESERVED',
  );
  requireThat(
    JSON.stringify(b.functions.map((f) => f.name).sort()) === JSON.stringify(expected) &&
      b.functions.every(
        (f) => Number.isSafeInteger(f.reservedConcurrency) && f.reservedConcurrency > 0 && [1, 2].includes(f.poolMax),
      ),
    'ALL_AUTHORITY_FUNCTION_BUDGETS_REQUIRED',
  );
  const ordinary = b.maxConnections - b.superuserReserved - b.reserved - b.rdsReserved;
  const existing = b.functions.reduce((n, f) => n + f.reservedConcurrency * f.poolMax, 0);
  const required = existing + b.operationalReserve + b.idleOverlapReserve + b.otherClients + 1;
  requireThat(required <= ordinary, 'WRITER_CONNECTION_BUDGET_EXCEEDED');
  return {
    ordinarySlots: ordinary,
    existingConnections: existing,
    writerConnections: 1,
    operationalReserve: b.operationalReserve,
    idleOverlapReserve: b.idleOverlapReserve,
    required,
    remaining: ordinary - required,
  };
}
export interface Network {
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  sourceRef: string;
  observedAt: string;
}
export function checkNetwork(n: Network, now: number) {
  requireThat(
    /^vpc-[a-f0-9]{8,17}$/u.test(n.vpcId) &&
      n.subnetIds.length === 2 &&
      new Set(n.subnetIds).size === 2 &&
      n.subnetIds.every((s) => /^subnet-[a-f0-9]{8,17}$/u.test(s)) &&
      n.securityGroupIds.length === 1 &&
      /^sg-[a-f0-9]{8,17}$/u.test(n.securityGroupIds[0]!) &&
      n.sourceRef.length > 0 &&
      Date.parse(n.observedAt) <= now &&
      now - Date.parse(n.observedAt) <= 300000,
    'IMPORTED_NETWORK_EVIDENCE_REQUIRED',
  );
}
export interface ToolAsset {
  path: string;
  sha256: string;
  codeSha256: string;
  manifestHash: string;
}
export interface ToolStackProps extends StackProps {
  writer: BoundManifest;
  verifier?: BoundManifest;
  writerAsset: ToolAsset;
  verifierAsset?: ToolAsset;
  bindingReceipt?: BindingReceipt;
  previousWriterAssetSha256?: string;
  phase: Phase;
  deviceId?: string;
  network: Network;
  budget: Budget;
  now: number;
}
export class Img21ToolsStack extends Stack {
  constructor(scope: Construct, id: string, p: ToolStackProps) {
    super(scope, id, { ...p, env: { account: TARGET.accountId, region: TARGET.region } });
    requireThat(
      p.writer.manifest.writerVersion === 'PUBLISHED' &&
        p.writer.manifest.verification === null &&
        p.writer.manifest.verifierBinding === null,
      'MC02_WRITER_MANIFEST_REQUIRED',
    );
    checkWindow(p.writer, p.now);
    if (p.verifier) {
      const snap = p.verifier.manifest.verification;
      requireThat(
        snap?.observedAt && Date.parse(snap.observedAt) <= p.now && p.now < Date.parse(snap.expiresAt),
        'FRESH_VERIFIER_SNAPSHOT_REQUIRED',
      );
    }
    checkNetwork(p.network, p.now);
    checkBudget(p.budget, p.now);
    requireThat(!!p.verifier === !!p.verifierAsset, 'VERIFIER_ASSET_PAIR_REQUIRED');
    requireThat(p.phase === 'A' ? !p.verifier : !!p.verifier, 'PHASE_A_WRITER_ONLY_PHASE_B_PAIR_REQUIRED');
    if (p.verifier) validateManifestPair(p.writer, p.verifier);
    const wr = writerPolicy(p.phase, p.deviceId);
    if (p.phase === 'B') {
      requireThat(p.bindingReceipt && p.previousWriterAssetSha256, 'PHASE_B_RECEIPT_REQUIRED');
      validatePhaseB(p.writer, p.bindingReceipt, p.deviceId!, p.previousWriterAssetSha256, p.writerAsset.sha256);
      if (p.verifier)
        requireThat(
          jsonHash(p.verifier.manifest.verifierBinding) === jsonHash(p.bindingReceipt.binding),
          'PHASE_B_VERIFIER_BINDING_MISMATCH',
        );
    }
    for (const kind of ['writer', 'verifier'] as const) {
      if (kind === 'verifier' && !p.verifier) continue; // Phase A must not publish an unbound verifier.
      const bound = kind === 'writer' ? p.writer : p.verifier!,
        artifact = kind === 'writer' ? p.writerAsset : p.verifierAsset!;
      requireThat(
        digest(readFileSync(artifact.path)) === artifact.sha256 &&
          Buffer.from(artifact.sha256, 'hex').toString('base64') === artifact.codeSha256 &&
          artifact.manifestHash === bound.hash,
        'ASSET_OR_MANIFEST_DRIFT',
      );
      verifyLambdaPackage(readFileSync(artifact.path), bound);
      const boundary = new CfnManagedPolicy(this, kind + 'Boundary', {
        managedPolicyName: `FDP-IMG21-${kind === 'writer' ? 'Writer' : 'Verifier'}Boundary`,
        policyDocument: kind === 'writer' ? writerBoundary() : verifierPolicy(),
      });
      boundary.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const role = new CfnRole(this, kind + 'Role', {
        roleName: roleName(kind),
        path: '/img21/',
        permissionsBoundary: boundary.ref,
        assumeRolePolicyDocument: runtimeTrust(),
        policies: [{ policyName: 'IMG21Runtime', policyDocument: kind === 'writer' ? wr : verifierPolicy() }],
      });
      role.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const logName = `/aws/lambda/fdp-test-img21-${kind === 'writer' ? 'controlled-writer' : 'license-verifier'}`;
      const logs = new CfnLogGroup(this, kind + 'Logs', { logGroupName: logName, retentionInDays: 30 });
      logs.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const asset = new Asset(this, kind + 'Zip', {
        path: artifact.path,
        assetHash: artifact.sha256,
        assetHashType: AssetHashType.CUSTOM,
      });
      const fn = new CfnFunction(this, kind + 'Function', {
        functionName: functionArn(kind).split(':').at(-1)!,
        role: role.attrArn,
        runtime: 'nodejs24.x',
        architectures: ['arm64'],
        handler: 'index.handler',
        timeout: 30,
        memorySize: kind === 'writer' ? 512 : 256,
        reservedConcurrentExecutions: 1,
        code: { s3Bucket: asset.s3BucketName, s3Key: asset.s3ObjectKey },
        environment: {
          variables: {
            IMG21_MANIFEST_SHA256: bound.hash,
            ...(kind === 'writer'
              ? {
                  LIVE_IMAGE_CONTROL_TABLE: TARGET.controlTable,
                  LIVE_IMAGE_PAYLOAD_TABLE: TARGET.payloadTable,
                  FDP_DB_POOL_MAX: '1',
                }
              : {}),
          },
        },
        runtimeManagementConfig: { updateRuntimeOn: 'FunctionUpdate' },
        loggingConfig: { logGroup: logName, logFormat: 'JSON' },
        ...(kind === 'writer'
          ? { vpcConfig: { subnetIds: p.network.subnetIds, securityGroupIds: p.network.securityGroupIds } }
          : {}),
      });
      fn.addResourceDependency(logs);
      fn.addResourceDependency(role);
      fn.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const version = new CfnVersion(this, kind + 'Version' + artifact.sha256.slice(0, 16), {
        functionName: fn.ref,
        codeSha256: artifact.codeSha256,
        description: `IMG21 ${bound.hash}`,
      });
      version.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const asyncSettings = new CfnEventInvokeConfig(this, kind + 'NoAsyncRetry' + artifact.sha256.slice(0, 16), {
        functionName: fn.ref,
        qualifier: version.attrVersion,
        maximumRetryAttempts: 0,
        maximumEventAgeInSeconds: 60,
      });
      asyncSettings.applyRemovalPolicy(RemovalPolicy.RETAIN);
      new CfnOutput(this, kind + 'PublishedArn', { value: `${functionArn(kind)}:${version.attrVersion}` });
      new CfnOutput(this, kind + 'ManifestHash', { value: bound.hash });
    }
    new CfnOutput(this, 'Admission', {
      value: 'NOT_GRANTED: post-publish observation and separate Invoke policy review required',
    });
  }
}
