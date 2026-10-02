import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertCaRepairPermissions } from './qa09-ca-root-permissions.mjs';
import { ACCEPTANCE_COMMIT } from './collect-qa09-application-version.mjs';
const account = '065986019555',
  region = 'ap-southeast-1';
const roleName = 'fdp-test-onboarding-provisioning-role',
  workerName = 'fdp-test-onboarding-provisioning';
const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
const boundaryArn = `arn:aws:iam::${account}:policy/FDP-ServiceBoundary`;
const secretArn = `arn:aws:secretsmanager:${region}:${account}:secret:fdp-test-device-ca-mecYC7`;
const keyArn = `arn:aws:kms:${region}:${account}:key/22af85c4-76d3-40c9-a849-0621740afe6c`;
const evidence = 'docs/audit/evidence';
const writePolicyName = 'QA09CaRootRepair';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function demand(ok, code) {
  if (!ok) throw Error(code);
}
function aws(args, profile = 'esgiot-readonly', absent = false) {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 1048576 },
  );
  if (r.status !== 0) {
    if (absent && /NoSuchEntity|ResourceNotFoundException/.test(r.stderr ?? '')) return null;
    throw Error(`AWS_${args[1]}_${r.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED'}`);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const workerConfig = () => aws(['lambda', 'get-function-configuration', '--function-name', workerName]);
function binding(c) {
  return Object.fromEntries(
    [
      'Role',
      'Runtime',
      'CodeSha256',
      'Environment',
      'VpcConfig',
      'Timeout',
      'MemorySize',
      'Architectures',
      'LoggingConfig',
      'Layers',
      'KMSKeyArn',
    ].map((k) => [k, c[k]]),
  );
}
async function active(name) {
  for (let i = 0; i < 45; i++) {
    const c = aws(['lambda', 'get-function-configuration', '--function-name', name]);
    if (c.State === 'Active' && c.LastUpdateStatus !== 'InProgress') {
      demand(c.LastUpdateStatus !== 'Failed', 'FUNCTION_UPDATE_FAILED');
      return c;
    }
    await pause(2000);
  }
  throw Error('FUNCTION_NOT_ACTIVE');
}
async function child(args) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
    p.on('error', () => reject(Error('CHILD_FAILED')));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(Error('TEN_DEVICE_FAILED'))));
  });
}
export async function main(output, versionPath, tenPath, recoveryReceiptPath) {
  demand(output && versionPath && tenPath, 'PATHS_REQUIRED');
  const previous = recoveryReceiptPath ? JSON.parse(readFileSync(recoveryReceiptPath)) : null;
  if (previous)
    demand(
      previous.scope === 'AWS_ONLY_CA_ROOT_REPAIR_AND_TEN_DEVICE' &&
        previous.repair?.baselineVersion === 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9' &&
        previous.repair.otherFieldsUnchanged === true &&
        previous.secretValuesExported === false &&
        /^[a-f0-9-]{36}$/.test(previous.candidateToken),
      'RECOVERY_RECEIPT_INVALID',
    );
  const policyName = previous ? 'QA09DeviceCaDecrypt' : writePolicyName;
  const nonce = randomBytes(16).toString('hex'),
    fn = `fdp-test-qa09-ca-repair-${nonce.slice(0, 16)}`,
    token = previous?.candidateToken ?? randomUUID();
  const receipt = {
    task: 'QA-09',
    scope: 'AWS_ONLY_CA_ROOT_REPAIR_AND_TEN_DEVICE',
    account,
    region,
    startedAt: new Date().toISOString(),
    requestNonce: nonce,
    functionName: fn,
    candidateToken: token,
    gate: 'RUNNING',
    secretValuesExported: false,
    privateKeysExported: false,
    fullQa09Accepted: false,
    cleanup: [],
    recoveryReceipt: recoveryReceiptPath ?? null,
    mode: previous ? 'VERIFY_EXISTING_VERSION_READ_ONLY' : 'WRITE_ROOT_FIELD',
    noTemporaryPermissions: previous?.postCleanupWorkerCaReadable === true,
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  save();
  const dir = mkdtempSync(join(tmpdir(), 'qa09-root-repair-'));
  const proposed = JSON.parse(readFileSync(`${evidence}/qa-09-ca-root-boundary-proposed-2026-10-02.json`));
  const baseline = JSON.parse(readFileSync(`${evidence}/qa-09-ca-root-boundary-baseline-2026-10-02.json`)).PolicyVersion
    .Document;
  const writePolicyPath = `${evidence}/qa-09-ca-root-worker-policy-proposed-2026-10-02.json`;
  const policyPath = previous ? `${evidence}/qa-09-device-ca-decrypt-proposed-policy-2026-10-02.json` : writePolicyPath;
  const policy = JSON.parse(readFileSync(policyPath));
  let temporaryVersion,
    policyAttempted = false,
    functionAttempted = false,
    zipSha,
    originalWorker,
    refreshAttempted = false;
  const policyDoc = (version) =>
    aws(['iam', 'get-policy-version', '--policy-arn', boundaryArn, '--version-id', version]).PolicyVersion.Document;
  const defaultVersion = () => aws(['iam', 'get-policy', '--policy-arn', boundaryArn]).Policy.DefaultVersionId;
  const rolePolicy = () =>
    aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName], 'esgiot-readonly', true);
  const originalRolePolicy = () =>
    aws([
      'iam',
      'get-role-policy',
      '--role-name',
      roleName,
      '--policy-name',
      'OnboardingProvisioningFnServiceRoleDefaultPolicyFF905558',
    ]).PolicyDocument;
  const originalDefault = JSON.parse(readFileSync(`${evidence}/qa-09-provisioning-role-policy-2026-10-02.json`));
  try {
    assertCaRepairPermissions(baseline, proposed, JSON.parse(readFileSync(writePolicyPath)));
    if (previous)
      demand(
        hash(readFileSync(policyPath)) === '518be0a8e11e8f95a1b186804483488c19f34621b7218958c74bf38d723c6c3a',
        'RECOVERY_PERMISSION_SCOPE_MISMATCH',
      );
    demand(new Date() < new Date('2026-10-03T00:00:00Z'), 'AUTHORIZATION_EXPIRED');
    const version = JSON.parse(readFileSync(versionPath));
    demand(
      version.gate === 'PASS' &&
        version.sourceCommit === ACCEPTANCE_COMMIT &&
        version.github?.headSha === ACCEPTANCE_COMMIT &&
        version.github?.conclusion === 'success' &&
        version.ci?.headSha === ACCEPTANCE_COMMIT &&
        version.ci?.conclusion === 'success' &&
        version.amplify?.[0]?.commitId === ACCEPTANCE_COMMIT &&
        version.amplify[0].status === 'SUCCEED' &&
        version.lambdaArtifacts?.length === 19 &&
        version.lambdaArtifacts.every((a) => a.matches === true && a.artifactSha256 === a.codeSha256) &&
        Date.now() - Date.parse(version.collectedAt) >= 0 &&
        Date.now() - Date.parse(version.collectedAt) < 1800000,
      'APPLICATION_VERSION_NOT_VERIFIED',
    );
    const identity = aws(['sts', 'get-caller-identity'], 'esgiot-infra');
    demand(
      identity.Account === account && identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'),
      'WRONG_IDENTITY',
    );
    demand(defaultVersion() === 'v3' && isDeepStrictEqual(policyDoc('v3'), baseline), 'BOUNDARY_DRIFT');
    demand(isDeepStrictEqual(proposed.Statement.slice(0, -1), baseline.Statement), 'PROPOSED_BOUNDARY_NOT_ADDITIVE');
    demand(
      aws(['iam', 'get-role', '--role-name', roleName]).Role.PermissionsBoundary.PermissionsBoundaryArn === boundaryArn,
      'ROLE_BOUNDARY_DRIFT',
    );
    demand(isDeepStrictEqual(originalRolePolicy(), originalDefault), 'ORIGINAL_ROLE_POLICY_DRIFT');
    demand(rolePolicy() === null, 'TEMP_POLICY_PRESENT');
    demand(
      aws(
        ['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', 'QA09DeviceCaDecrypt'],
        'esgiot-readonly',
        true,
      ) === null,
      'OLD_TEMP_POLICY_PRESENT',
    );
    const meta = aws(['secretsmanager', 'describe-secret', '--secret-id', secretArn]);
    demand(
      meta.ARN === secretArn &&
        meta.KmsKeyId === keyArn &&
        meta.VersionIdsToStages?.[previous ? token : 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9']?.includes('AWSCURRENT'),
      'SECRET_METADATA_DRIFT',
    );
    receipt.beforeVersionStages = meta.VersionIdsToStages;
    const kp = JSON.parse(aws(['kms', 'get-key-policy', '--key-id', keyArn, '--policy-name', 'default']).Policy);
    demand(
      isDeepStrictEqual(kp, JSON.parse(readFileSync(`${evidence}/qa-09-device-ca-key-policy-2026-10-02.json`))),
      'KEY_POLICY_DRIFT',
    );
    originalWorker = workerConfig();
    demand(originalWorker.Role === roleArn && originalWorker.Runtime === 'nodejs24.x', 'WORKER_DRIFT');
    receipt.workerBefore = {
      description: originalWorker.Description ?? '',
      revisionId: originalWorker.RevisionId,
      bindingHash: hash(JSON.stringify(binding(originalWorker))),
    };
    const domain = aws([
      'apigatewayv2',
      'get-domain-name',
      '--domain-name',
      'device-api.bio-nexa.com',
      '--query',
      'MutualTlsAuthentication',
    ]);
    demand(
      domain.TruststoreVersion === 'FtN.3H5AydTqt6cgxf0wzeOcNQHFxCOx' &&
        domain.TruststoreUri === `s3://fdp-test-mtls-truststore-${account}/truststore/ca-bundle.pem`,
      'TRUSTSTORE_DRIFT',
    );
    aws([
      's3api',
      'get-object',
      '--bucket',
      `fdp-test-mtls-truststore-${account}`,
      '--key',
      'truststore/ca-bundle.pem',
      '--version-id',
      domain.TruststoreVersion,
      join(dir, 'truststore.pem'),
    ]);
    demand(
      hash(readFileSync(join(dir, 'truststore.pem'))) ===
        '447dfa9a580c6bfd3126c7661519e46820f3e4919b1862f39e2d1683a349a0de',
      'TRUSTSTORE_BYTES_DRIFT',
    );
    receipt.sources = [];
    for (const name of ['qa09-ca-root-repair-handler.mjs', 'qa09-ca-root-repair.mjs', 'qa09-ca-chain-diagnostic.mjs']) {
      const bytes = readFileSync(`scripts/${name}`);
      writeFileSync(join(dir, name), bytes);
      receipt.sources.push({ path: `scripts/${name}`, sha256: hash(bytes), sourceBase64: bytes.toString('base64') });
    }
    const z = spawnSync('python3', [
      '-c',
      "import pathlib,zipfile,sys; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/'repair.zip','w',zipfile.ZIP_DEFLATED); [z.write(f,f.name) for f in p.iterdir() if f.suffix in ['.mjs','.pem']]; z.close()",
      dir,
    ]);
    demand(z.status === 0, 'ZIP_FAILED');
    zipSha = createHash('sha256')
      .update(readFileSync(join(dir, 'repair.zip')))
      .digest('base64');
    receipt.codeSha256 = zipSha;
    save();
    if (!previous) {
      temporaryVersion = aws(
        [
          'iam',
          'create-policy-version',
          '--policy-arn',
          boundaryArn,
          '--policy-document',
          `file://${resolve(`${evidence}/qa-09-ca-root-boundary-proposed-2026-10-02.json`)}`,
        ],
        'esgiot-infra',
      ).PolicyVersion.VersionId;
      receipt.temporaryBoundaryVersion = temporaryVersion;
      save();
      demand(
        defaultVersion() === 'v3' && isDeepStrictEqual(policyDoc(temporaryVersion), proposed),
        'BOUNDARY_CANDIDATE_DRIFT',
      );
      aws(
        ['iam', 'set-default-policy-version', '--policy-arn', boundaryArn, '--version-id', temporaryVersion],
        'esgiot-infra',
      );
      demand(defaultVersion() === temporaryVersion, 'BOUNDARY_NOT_APPLIED');
      receipt.boundaryApplied = true;
      save();
    }
    if (!receipt.noTemporaryPermissions) {
      policyAttempted = true;
      aws(
        [
          'iam',
          'put-role-policy',
          '--role-name',
          roleName,
          '--policy-name',
          policyName,
          '--policy-document',
          `file://${resolve(policyPath)}`,
        ],
        'esgiot-infra',
      );
      demand(isDeepStrictEqual(rolePolicy()?.PolicyDocument, policy), 'ROLE_POLICY_READBACK_FAILED');
      receipt.policyApplied = true;
      save();
      await pause(10000);
    }
    functionAttempted = true;
    const created = aws(
      [
        'lambda',
        'create-function',
        '--function-name',
        fn,
        '--runtime',
        'nodejs24.x',
        '--role',
        roleArn,
        '--handler',
        'qa09-ca-root-repair-handler.handler',
        '--zip-file',
        `fileb://${join(dir, 'repair.zip')}`,
        '--timeout',
        '120',
        '--memory-size',
        '128',
        '--logging-config',
        JSON.stringify({ LogFormat: 'JSON', LogGroup: originalWorker.LoggingConfig.LogGroup }),
        '--description',
        'QA09 authorized one-shot root field only repair; metadata output',
        '--tags',
        JSON.stringify({ 'fdp:env': 'test', 'fdp:project': 'food-digester-platform', 'fdp:task': 'QA-09' }),
        '--publish',
      ],
      'esgiot-infra',
    );
    demand(created.CodeSha256 === zipSha && created.Version === '1', 'FUNCTION_BINDING_FAILED');
    await active(fn);
    writeFileSync(
      join(dir, 'event.json'),
      JSON.stringify({
        operation: previous ? 'VERIFY_EXISTING_ROOT_VERSION' : 'REPAIR_CA_ROOT_ONLY',
        requestNonce: nonce,
        candidateToken: token,
      }),
    );
    receipt.invocation = aws(
      [
        'lambda',
        'invoke',
        '--function-name',
        fn,
        '--qualifier',
        '1',
        '--cli-read-timeout',
        '150',
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        `file://${join(dir, 'event.json')}`,
        join(dir, 'result.json'),
      ],
      'esgiot-infra',
    );
    demand(!receipt.invocation.FunctionError && receipt.invocation.ExecutedVersion === '1', 'REPAIR_INVOKE_FAILED');
    const result = JSON.parse(readFileSync(join(dir, 'result.json')));
    demand(!/-----BEGIN|SecretString|caPrivateKeyPem|caCertificatePem/.test(JSON.stringify(result)), 'OUTPUT_REJECTED');
    receipt.repair = result;
    save();
    demand(
      result.schema === 'fdp-qa09-ca-root-repair/v1' &&
        result.requestNonce === nonce &&
        result.candidateVersion === token &&
        result.completed &&
        result.otherFieldsUnchanged &&
        result.originalVersionRetained,
      'REPAIR_NOT_VERIFIED',
    );
    receipt.afterVersionStages = aws([
      'secretsmanager',
      'describe-secret',
      '--secret-id',
      secretArn,
    ]).VersionIdsToStages;
    save();
    const beforeRefresh = workerConfig();
    demand(
      beforeRefresh.RevisionId === originalWorker.RevisionId &&
        isDeepStrictEqual(binding(beforeRefresh), binding(originalWorker)),
      'WORKER_PRE_REFRESH_DRIFT',
    );
    receipt.refreshDescription = `QA09 CA root refresh ${nonce}`;
    save();
    refreshAttempted = true;
    aws(
      [
        'lambda',
        'update-function-configuration',
        '--function-name',
        workerName,
        '--revision-id',
        beforeRefresh.RevisionId,
        '--description',
        receipt.refreshDescription,
      ],
      'esgiot-infra',
    );
    const refreshed = await active(workerName);
    demand(
      refreshed.Description === receipt.refreshDescription &&
        isDeepStrictEqual(binding(refreshed), binding(originalWorker)),
      'WORKER_REFRESH_DRIFT',
    );
    receipt.workerRefreshed = { revisionId: refreshed.RevisionId, bindingUnchanged: true };
    save();
    receipt.tenDeviceReceipt = tenPath;
    save();
    await child(['--import', 'tsx', 'scripts/run-qa09-ten-device-acceptance.mjs', tenPath, versionPath]);
    receipt.tenDevice = { gate: JSON.parse(readFileSync(tenPath)).gate };
    demand(receipt.tenDevice.gate === 'PASS', 'TEN_DEVICE_FAILED');
    receipt.gate = 'PASS';
    save();
  } catch (error) {
    receipt.gate = 'FAIL';
    receipt.errorCode = /^[A-Za-z0-9_-]{1,120}$/.test(error.message ?? '') ? error.message : 'REPAIR_EXECUTION_FAILED';
    save();
  } finally {
    const cleanup = async (type, fn) => {
      try {
        await fn();
        receipt.cleanup.push({ type, result: 'PASS' });
      } catch (error) {
        receipt.cleanup.push({
          type,
          result: 'FAIL',
          errorCode: /^[A-Za-z0-9_-]{1,120}$/.test(error.message ?? '') ? error.message : 'CLEANUP_FAILED',
        });
        receipt.gate = 'FAIL';
      }
      save();
    };
    if (refreshAttempted)
      await cleanup('worker-description-restored', async () => {
        const c = await active(workerName);
        demand(
          c.Description === receipt.refreshDescription && isDeepStrictEqual(binding(c), binding(originalWorker)),
          'WORKER_CLEANUP_DRIFT',
        );
        aws(
          [
            'lambda',
            'update-function-configuration',
            '--function-name',
            workerName,
            '--revision-id',
            c.RevisionId,
            '--description',
            originalWorker.Description ?? '',
          ],
          'esgiot-infra',
        );
        const restored = await active(workerName);
        demand(
          restored.Description === (originalWorker.Description ?? '') &&
            isDeepStrictEqual(binding(restored), binding(originalWorker)),
          'WORKER_NOT_RESTORED',
        );
      });
    if (policyAttempted)
      await cleanup('temporary-worker-policy-revoked', () => {
        const p = rolePolicy();
        if (p) {
          demand(isDeepStrictEqual(p.PolicyDocument, policy), 'POLICY_CLEANUP_DRIFT');
          aws(['iam', 'delete-role-policy', '--role-name', roleName, '--policy-name', policyName], 'esgiot-infra');
        }
        demand(rolePolicy() === null, 'POLICY_REMAINS');
      });
    if (temporaryVersion)
      await cleanup('boundary-restored-v3-temporary-version-deleted', () => {
        const current = defaultVersion();
        demand(current === temporaryVersion || current === 'v3', 'BOUNDARY_CONCURRENT_DRIFT');
        demand(
          isDeepStrictEqual(policyDoc('v3'), baseline) && isDeepStrictEqual(policyDoc(temporaryVersion), proposed),
          'BOUNDARY_CLEANUP_DRIFT',
        );
        if (current === temporaryVersion)
          aws(['iam', 'set-default-policy-version', '--policy-arn', boundaryArn, '--version-id', 'v3'], 'esgiot-infra');
        demand(defaultVersion() === 'v3', 'BOUNDARY_NOT_RESTORED');
        aws(
          ['iam', 'delete-policy-version', '--policy-arn', boundaryArn, '--version-id', temporaryVersion],
          'esgiot-infra',
        );
        demand(
          !aws(['iam', 'list-policy-versions', '--policy-arn', boundaryArn]).Versions.some(
            (v) => v.VersionId === temporaryVersion,
          ),
          'BOUNDARY_VERSION_REMAINS',
        );
      });
    if (receipt.noTemporaryPermissions)
      await cleanup('no-temporary-worker-policy-needed', () => {
        demand(rolePolicy() === null, 'TEMP_POLICY_REMAINS');
      });
    if (previous)
      await cleanup('boundary-v3-preserved-no-write-grant', () => {
        demand(defaultVersion() === 'v3' && isDeepStrictEqual(policyDoc('v3'), baseline), 'BOUNDARY_RECOVERY_DRIFT');
        demand(
          aws(
            ['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', writePolicyName],
            'esgiot-readonly',
            true,
          ) === null,
          'WRITE_POLICY_REMAINS',
        );
      });
    if (functionAttempted && receipt.repair?.completed) {
      try {
        writeFileSync(
          join(dir, 'verify.json'),
          JSON.stringify({ operation: 'VERIFY_CURRENT_CA_CHAIN', requestNonce: nonce, candidateToken: token }),
        );
        const invoke = aws(
          [
            'lambda',
            'invoke',
            '--function-name',
            fn,
            '--qualifier',
            '1',
            '--cli-binary-format',
            'raw-in-base64-out',
            '--payload',
            `file://${join(dir, 'verify.json')}`,
            join(dir, 'verified.json'),
          ],
          'esgiot-infra',
        );
        demand(!invoke.FunctionError, 'POST_CLEANUP_READ_INVOKE_FAILED');
        const verified = JSON.parse(readFileSync(join(dir, 'verified.json')));
        demand(
          !/-----BEGIN|SecretString|caPrivateKeyPem"\s*:|caCertificatePem"\s*:/.test(JSON.stringify(verified)),
          'OUTPUT_REJECTED',
        );
        receipt.postCleanupRead = verified;
        receipt.postCleanupWorkerCaReadable =
          verified.completed === true &&
          verified.workerChainValid === true &&
          verified.privateKeyMatchesSigningCertificate === true &&
          verified.secretVersionId === token;
      } catch {
        receipt.postCleanupWorkerCaReadable = false;
        receipt.postCleanupRead = { completed: false, errorCode: 'POST_CLEANUP_AWS_READ_FAILED' };
      }
      save();
    }
    if (functionAttempted)
      await cleanup('temporary-function-deleted', () => {
        const c = aws(['lambda', 'get-function-configuration', '--function-name', fn], 'esgiot-readonly', true);
        if (c) {
          demand(c.Role === roleArn && c.CodeSha256 === zipSha, 'FUNCTION_CLEANUP_DRIFT');
          aws(['lambda', 'delete-function', '--function-name', fn], 'esgiot-infra');
        }
        demand(
          aws(['lambda', 'get-function-configuration', '--function-name', fn], 'esgiot-readonly', true) === null,
          'FUNCTION_REMAINS',
        );
      });
    await cleanup('original-worker-policy-and-boundary-preserved', () => {
      demand(isDeepStrictEqual(originalRolePolicy(), originalDefault), 'ORIGINAL_POLICY_CHANGED');
      demand(
        aws(['iam', 'get-role', '--role-name', roleName]).Role.PermissionsBoundary.PermissionsBoundaryArn ===
          boundaryArn,
        'ROLE_BOUNDARY_CHANGED',
      );
    });
    rmSync(dir, { recursive: true, force: true });
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(...process.argv.slice(2)).then((r) => {
    console.log(JSON.stringify({ gate: r.gate, errorCode: r.errorCode, repair: r.repair, cleanup: r.cleanup }));
    process.exitCode = r.gate === 'PASS' ? 0 : 1;
  });
