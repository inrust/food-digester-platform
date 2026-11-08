/** Offline planning only. Git/file reads and draft files; no AWS/HTTP/DB/credentials. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  CANDIDATE,
  G3,
  ROOT,
  verifyG3,
  manifestRows,
  readCandidateFiles,
  PREPARATION_SOURCE_FILES,
  PACKAGE,
} from '../../../../scripts/device-image-target-package.mjs';
const base = fileURLToPath(new URL('./', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const inputEvidence = [];
const load = (p) => {
  const bytes = readFileSync(resolve(ROOT, p));
  const committed = Buffer.from(git(['show', `91604a70:${p}`]));
  if (sha(bytes) !== sha(committed)) throw Error('RETAINED_EVIDENCE_DRIFT');
  inputEvidence.push({ path: p, sha256: sha(bytes), gitCommit: '91604a70' });
  return JSON.parse(bytes);
};
const write = (p, v) => {
  mkdirSync(resolve(base, p, '..'), { recursive: true });
  writeFileSync(resolve(base, p), JSON.stringify(v, null, 2) + '\n');
};
function git(args, input) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    input,
    encoding: input ? 'buffer' : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw Error('LOCAL_GIT_READ_FAILED');
  return r.stdout;
}
const old = '69c76e1dd508bf6e03dd21992194a8280109cd0a';
const binding = verifyG3();
if (
  sha(readFileSync(resolve(ROOT, G3, 'sources.sha256'))) !== binding.sources.sha256 ||
  sha(readFileSync(resolve(ROOT, G3, 'verification-sources.sha256'))) !== binding.verificationSources.sha256
)
  throw Error('G3_MANIFEST_COPY_DRIFT');
const rows = manifestRows(readFileSync(resolve(ROOT, G3, 'sources.sha256')));
const allRows = manifestRows(readFileSync(resolve(ROOT, G3, 'verification-sources.sha256')));
const candidate = readCandidateFiles(allRows.map((r) => r.path));
const bytes = git(['cat-file', '--batch'], Buffer.from(allRows.map((r) => `${old}:${r.path}\n`).join('')));
let offset = 0;
const hashes = {};
for (const row of allRows) {
  const end = bytes.indexOf(10, offset);
  const match = /^[a-f0-9]{40} blob (\d+)$/u.exec(bytes.subarray(offset, end).toString());
  if (!match) throw Error('HISTORICAL_SOURCE_MISSING');
  offset = end + 1;
  const size = Number(match[1]);
  hashes[row.path] = sha(bytes.subarray(offset, offset + size));
  offset += size;
  if (bytes[offset++] !== 10) throw Error('GIT_FRAME_MISMATCH');
}
if (offset !== bytes.length) throw Error('UNEXPECTED_GIT_TRAILER');
const changed = rows.filter((r) => hashes[r.path] !== sha(candidate[r.path])).map((r) => r.path);
const metadataOnly = (p) =>
  PREPARATION_SOURCE_FILES.includes(p) ||
  p.startsWith(PACKAGE + '/') ||
  p.startsWith('docs/audit/') ||
  p.startsWith('docs/dev/') ||
  ['.gitattributes', 'docs/api/device-image-development-plan.md'].includes(p);
const diff = git(['diff', '--name-only', '--no-renames', '-z', old, CANDIDATE]).split('\0').filter(Boolean);
const trees = [
  'apps',
  'packages',
  'contracts',
  'infra',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/esgiot-cdk.mjs',
].map((path) => {
  const oldTree = git(['rev-parse', `${old}:${path}`]).trim(),
    candidateTree = git(['rev-parse', `${CANDIDATE}:${path}`]).trim();
  return { path, oldTree, candidateTree, equal: oldTree === candidateTree };
});
const previous = 'docs/audit/evidence/2026-11-08-device-image-fixture-execution';
const observed = load(previous + '/current-readonly-observations.json');
const artifacts = load(
  'docs/audit/evidence/2026-11-08-device-image-G4-readiness/observations/asset-full-object-sha256.json',
);
const matches = artifacts.lambdaArtifacts.map((a) => ({
  name: a.name,
  codeSha256: a.current.codeSha256,
  observedCodeSha256: observed.functions.find((f) => f.name === a.name)?.data.codeSha256,
  matches: observed.functions.find((f) => f.name === a.name)?.data.codeSha256 === a.current.codeSha256,
  sourceVersion: a.sourceVersion,
  checksumType: a.checksum.ChecksumType,
}));
if (
  rows.length !== binding.sources.count ||
  allRows.length !== binding.verificationSources.count ||
  new Set(artifacts.lambdaArtifacts.map((a) => a.name)).size !== 20 ||
  observed.functions.length !== 20 ||
  artifacts.lambdaArtifacts.some(
    (a) =>
      !a.matches ||
      !a.sourceVersion ||
      a.checksum.ChecksumType !== 'FULL_OBJECT' ||
      a.checksum.ChecksumSHA256 !== a.current.codeSha256 ||
      a.artifactSha256 !== a.current.codeSha256,
  ) ||
  changed.length ||
  diff.some((p) => !metadataOnly(p)) ||
  trees.some((t) => !t.equal) ||
  matches.length !== 20 ||
  matches.some((m) => !m.matches)
)
  throw Error('EQUIVALENCE_NOT_ESTABLISHED');
write('version-analysis.json', {
  status: 'PASS_LOCAL_APPLICATION_SOURCE_COMPARISON_ONLY',
  applicationCandidate: CANDIDATE,
  observedArtifactRelease: old,
  g3EvidenceCommit: binding.evidenceCommit,
  deliverySourceCount: rows.length,
  changedDeliverySources: changed,
  fullVerifySourceCount: allRows.length,
  changedFullVerifyInputs: allRows.filter((r) => hashes[r.path] !== sha(candidate[r.path])).map((r) => r.path),
  buildInputTrees: trees,
  changedPaths: diff,
  nonMetadataChangedPaths: diff.filter((p) => !metadataOnly(p)),
  metadataClassification: 'APPLICATION_BUILD_ONLY; changed audit/tool code requires its own source/version proof',
  lastRetainedTargetObservedAt: observed.capturedAt,
  lastRetainedApplicationFunctions: matches,
  inputEvidence,
  targetFreshReadsThisTask: 0,
  targetDeploymentProvenForCandidate: false,
  equivalenceAcceptanceApproved: false,
  g4: 'NOT_RUN',
  note: 'Source equality does not relabel the observed release or prove a hypothetical rebuild has identical bytes.',
});
const account = '065986019555',
  region = 'ap-southeast-1';
const control = `arn:aws:dynamodb:${region}:${account}:table/fdp-test-live-image-control`;
const dbSecret = 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-rds-credentials-hBessK';
const licenseSecret = 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-license-signing-key-OVgupB';
const key = 'arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c';
const pool = `arn:aws:cognito-idp:${region}:${account}:userpool/ap-southeast-1_hZMX8LpFo`;
const arn = (suffix) => `arn:aws:lambda:${region}:${account}:function:fdp-test-img21-${suffix}`;
const logs = (suffix) => ({
  Sid: 'WriteOwnLogs',
  Effect: 'Allow',
  Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
  Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/fdp-test-img21-${suffix}:log-stream:*`,
});
const secret = (name) => ({
  Sid: 'ReadOneSecret',
  Effect: 'Allow',
  Action: ['secretsmanager:GetSecretValue'],
  Resource: name,
});
const decrypt = (name) => ({
  Sid: 'DecryptOneSecretOnlyViaSecretsManager',
  Effect: 'Allow',
  Action: ['kms:Decrypt'],
  Resource: key,
  Condition: {
    StringEquals: {
      'kms:ViaService': `secretsmanager.${region}.amazonaws.com`,
      'kms:EncryptionContext:SecretARN': name,
    },
  },
});
const eniActions = [
  'ec2:CreateNetworkInterface',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeSubnets',
  'ec2:DeleteNetworkInterface',
  'ec2:AssignPrivateIpAddresses',
  'ec2:UnassignPrivateIpAddresses',
];
const writer = [
  secret(dbSecret),
  decrypt(dbSecret),
  {
    Sid: 'ReadCognitoOwnedIdentityMetadata',
    Effect: 'Allow',
    Action: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'],
    Resource: pool,
  },
  { Sid: 'ReadControlMetadataForExistingActorFence', Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: control },
  logs('controlled-writer'),
  { Sid: 'AllowLambdaVpcEniManagement', Effect: 'Allow', Action: eniActions, Resource: '*' },
  {
    Sid: 'DenyFunctionCodeEc2Calls',
    Effect: 'Deny',
    Action: eniActions,
    Resource: '*',
    Condition: { ArnEquals: { 'lambda:SourceFunctionArn': arn('controlled-writer') } },
  },
  {
    Sid: 'NeverDeleteControlEpoch',
    Effect: 'Deny',
    Action: ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    Resource: control,
  },
];
const put = {
  Sid: 'PutOnlyApprovedServerAssignedDevice',
  Effect: 'Allow',
  Action: ['dynamodb:PutItem'],
  Resource: control,
  Condition: {
    'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['DEVICE#{{BOUND_DEVICE_UUID}}'] },
    Null: { 'dynamodb:LeadingKeys': 'false' },
  },
};
const policy = (Statement) => ({ Version: '2012-10-17', Statement });
write('iam/writer-phase-a.template.json', policy(writer));
write('iam/writer-phase-b.template.json', policy([...writer, put]));
write(
  'iam/writer-boundary.template.json',
  policy([
    ...writer,
    { Sid: 'MaximumControlPutCeilingNotAGrant', Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: control },
  ]),
);
const verifier = [secret(licenseSecret), decrypt(licenseSecret), logs('license-verifier')];
write('iam/verifier.template.json', policy(verifier));
write('iam/verifier-boundary.template.json', policy(verifier));
write(
  'iam/runtime-trust.template.json',
  policy([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
);
write(
  'iam/operator-invoke.template.json',
  policy([
    {
      Sid: 'InvokeOnlyPublishedVersionsWithinApprovedWindow',
      Effect: 'Allow',
      Action: ['lambda:InvokeFunction'],
      Resource: [arn('controlled-writer') + ':{{WRITER_VERSION}}', arn('license-verifier') + ':{{VERIFIER_VERSION}}'],
      Condition: {
        DateGreaterThanEquals: { 'aws:CurrentTime': '{{WINDOW_START_UTC}}' },
        DateLessThan: { 'aws:CurrentTime': '{{WINDOW_END_UTC}}' },
      },
    },
  ]),
);
const writerRole = `arn:aws:iam::${account}:role/img21/fdp-test-img21-controlled-writer-role`;
const verifierRole = `arn:aws:iam::${account}:role/img21/fdp-test-img21-license-verifier-role`;
const writerBoundary = `arn:aws:iam::${account}:policy/FDP-IMG21-WriterBoundary`;
const verifierBoundary = `arn:aws:iam::${account}:policy/FDP-IMG21-VerifierBoundary`;
const deployDelta = [];
for (const [kind, role, boundary] of [
  ['Writer', writerRole, writerBoundary],
  ['Verifier', verifierRole, verifierBoundary],
]) {
  deployDelta.push({
    Sid: `CreateBoundIMG21${kind}Role`,
    Effect: 'Allow',
    Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
    Resource: role,
    Condition: { StringEquals: { 'iam:PermissionsBoundary': boundary } },
  });
  deployDelta.push({
    Sid: `DenyUnboundedIMG21${kind}Role`,
    Effect: 'Deny',
    Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
    Resource: role,
    Condition: { StringNotEquals: { 'iam:PermissionsBoundary': boundary } },
  });
}
deployDelta.push({
  Sid: 'ManageOnlyTwoIMG21RuntimeRoles',
  Effect: 'Allow',
  Action: [
    'iam:GetRole',
    'iam:TagRole',
    'iam:UntagRole',
    'iam:PutRolePolicy',
    'iam:GetRolePolicy',
    'iam:DeleteRolePolicy',
    'iam:ListRolePolicies',
    'iam:UpdateAssumeRolePolicy',
  ],
  Resource: [writerRole, verifierRole],
});
deployDelta.push({
  Sid: 'ManageOnlyTwoIMG21Boundaries',
  Effect: 'Allow',
  Action: [
    'iam:CreatePolicy',
    'iam:GetPolicy',
    'iam:GetPolicyVersion',
    'iam:CreatePolicyVersion',
    'iam:DeletePolicyVersion',
    'iam:SetDefaultPolicyVersion',
    'iam:ListPolicyVersions',
    'iam:TagPolicy',
    'iam:UntagPolicy',
  ],
  Resource: [writerBoundary, verifierBoundary],
});
deployDelta.push({
  Sid: 'PassOnlyIMG21RolesToLambda',
  Effect: 'Allow',
  Action: ['iam:PassRole'],
  Resource: [writerRole, verifierRole],
  Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
});
write('iam/deployer-delta.template.json', policy(deployDelta));
write('implementation-plan.json', {
  status: 'DESIGN_AND_LOCAL_REFERENCE_ONLY',
  applicationCandidate: CANDIDATE,
  existingControlPlanePolicyEditsPlanned: [
    'infra/iam/FDP-DeploymentBoundary.json',
    'infra/iam/FDP-CloudFormationExecutionPolicy.json',
  ],
  rolePath: '/img21/',
  deploymentAuthorized: false,
  iamChangesAuthorized: false,
  realG4Authorized: false,
  recommended: {
    writer: 'Private versioned Lambda with existing authority wrapper',
    verifier: 'Separate private versioned Lambda, exact license secret, no DB or DynamoDB',
    binding: 'Proposed reviewed application-source equivalence; observed release remains 69c76e1d',
  },
  newResources: {
    lambdaFunctions: 2,
    executionRoles: 2,
    permissionBoundaries: 2,
    logGroups: 2,
    newTables: 0,
    newPublicEndpoints: 0,
    newVpcs: 0,
    newSecrets: 0,
  },
  phases: [
    {
      id: 'MC01',
      work: 'Implement closed writer, atomic DB audit ledger and single-run verifier handlers/adapters',
      status: 'NOT_IMPLEMENTED',
    },
    {
      id: 'MC02',
      work: 'Implement isolated test-only IaC, phase A/B IAM, connection budget and fixed-version invocation',
      status: 'NOT_IMPLEMENTED',
    },
    {
      id: 'MC03',
      work: 'Review source-equivalence mode and implement proof v2/tool bindings; refresh candidate G3 where required',
      status: 'NOT_IMPLEMENTED',
    },
    {
      id: 'MC04',
      work: 'After separate authorization: phase A deployment, validate fixed version/policies and seed two own identities',
      status: 'NOT_RUN',
    },
    {
      id: 'MC05',
      work: 'Normal application provisioning, immutable server-ID/certificate binding and publishing the bound verifier',
      status: 'NOT_RUN',
    },
    {
      id: 'MC06',
      work: 'Bind one UUID to phase B PutItem and verifier version; validate permissions/authority/License and enable only own preview',
      status: 'NOT_RUN',
    },
    {
      id: 'MC07',
      work: 'Fresh explicitly approved G4 window for CF01-CF03; cleanup and independent source review',
      status: 'NOT_RUN',
    },
  ],
  requiredApprovals: [
    'TWO_NEW_PRIVATE_TEST_FUNCTIONS_AND_SCOPED_ROLES_BOUNDARIES',
    'CONTROL_METADATA_TABLE_READ_SCOPE_ACKNOWLEDGEMENT',
    'PHASE_B_POLICY_UPDATE_AFTER_REAL_DEVICE_ID',
    'VERSION_EQUIVALENCE_ACCEPTANCE_DECISION',
    'NEW_PREPARATION_AND_G4_WINDOWS',
  ],
  notRun: [
    'WORKER_RUNTIME_IMPLEMENTATION',
    'IAM_SERVICE_EVALUATION',
    'DEPLOYMENT',
    'NATIVE_WRITE_AND_DDB_CONCURRENCY',
    'REAL_LICENSE_SECRET_ACCESS',
    'FRESH_TARGET_VERSION_RECHECK',
    'CF01_CF02_CF03',
  ],
  activeAdmissionUnchanged: { provided: 11, missingOrExcluded: 11, g4: 'NOT_RUN' },
  appOrPhysicalDeviceRequired: false,
});
const generated = [
  'version-analysis.json',
  'implementation-plan.json',
  'iam/writer-phase-a.template.json',
  'iam/writer-phase-b.template.json',
  'iam/writer-boundary.template.json',
  'iam/verifier.template.json',
  'iam/verifier-boundary.template.json',
  'iam/runtime-trust.template.json',
  'iam/operator-invoke.template.json',
  'iam/deployer-delta.template.json',
];
write('draft-manifest.json', {
  formatVersion: 1,
  executable: false,
  cloudWrites: 0,
  files: Object.fromEntries(generated.map((p) => [p, sha(readFileSync(resolve(base, p)))])),
  unresolvedTemplateFields: [
    'BOUND_DEVICE_UUID',
    'WRITER_VERSION',
    'VERIFIER_VERSION',
    'WINDOW_START_UTC',
    'WINDOW_END_UTC',
  ],
  resourcesAreReferencesFromRepositoryAndRetainedEvidenceNotFreshCloudVerification: true,
});
process.stdout.write(
  JSON.stringify({
    status: 'PASS_OFFLINE_PLAN',
    deliverySources: rows.length,
    changed: changed.length,
    retainedArtifactHashesMatching: matches.length,
    deployments: 0,
    iamChanges: 0,
    g4: 'NOT_RUN',
  }) + '\n',
);
