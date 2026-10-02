import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const account = '065986019555',
  region = 'ap-southeast-1';
const roleName = 'fdp-test-onboarding-provisioning-role';
const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
const secretArn = `arn:aws:secretsmanager:${region}:${account}:secret:fdp-test-device-ca-mecYC7`;
const keyArn = `arn:aws:kms:${region}:${account}:key/22af85c4-76d3-40c9-a849-0621740afe6c`;
const policyName = 'QA09DeviceCaDecrypt';
const policyPath = 'docs/audit/evidence/qa-09-device-ca-decrypt-proposed-policy-2026-10-02.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function demand(ok, code) {
  if (!ok) throw Error(code);
}
function aws(args, profile = 'esgiot-readonly', absent = false) {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 },
  );
  if (r.status !== 0) {
    if (absent && /NoSuchEntity|ResourceNotFoundException/.test(r.stderr ?? '')) return null;
    const code = r.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED';
    throw Error(`AWS_${args[1]}_${code}`);
  }
  return r.stdout?.trim() ? JSON.parse(r.stdout) : null;
}
export async function main(output) {
  demand(output, 'OUTPUT_REQUIRED');
  const nonce = randomBytes(16).toString('hex');
  const functionName = `fdp-test-qa09-ca-chain-${nonce.slice(0, 16)}`;
  const source = readFileSync(new URL('./qa09-ca-chain-diagnostic.mjs', import.meta.url));
  const sourceHash = hash(source);
  const receipt = {
    task: 'QA-09',
    scope: 'AWS_ONLY_READ_ONLY_CA_CHAIN_DIAGNOSTIC',
    account,
    region,
    functionName,
    roleArn,
    sourceHash,
    requestNonce: nonce,
    startedAt: new Date().toISOString(),
    secretValuesExported: false,
    privateKeysExported: false,
    secretWrites: false,
    businessWrites: false,
    gate: 'RUNNING',
    cleanup: [],
    sourceBase64: source.toString('base64'),
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  save();
  const dir = mkdtempSync(join(tmpdir(), 'qa09-ca-diagnostic-'));
  let permissionAttempted = false,
    creationAttempted = false,
    zipSha,
    originalPolicy;
  const approved = JSON.parse(readFileSync(policyPath));
  try {
    demand(
      new Date() < new Date(approved.Statement[0].Condition.DateLessThan['aws:CurrentTime']),
      'AUTHORIZATION_EXPIRED',
    );
    const identity = aws(['sts', 'get-caller-identity'], 'esgiot-infra');
    demand(
      identity.Account === account && identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'),
      'WRONG_IDENTITY',
    );
    const role = aws(['iam', 'get-role', '--role-name', roleName], 'esgiot-infra').Role;
    demand(
      role.Arn === roleArn &&
        role.PermissionsBoundary?.PermissionsBoundaryArn === `arn:aws:iam::${account}:policy/FDP-ServiceBoundary`,
      'ROLE_OR_BOUNDARY_MISMATCH',
    );
    originalPolicy = aws([
      'iam',
      'get-role-policy',
      '--role-name',
      roleName,
      '--policy-name',
      'OnboardingProvisioningFnServiceRoleDefaultPolicyFF905558',
    ]).PolicyDocument;
    demand(
      JSON.stringify(originalPolicy) ===
        JSON.stringify(JSON.parse(readFileSync('docs/audit/evidence/qa-09-provisioning-role-policy-2026-10-02.json'))),
      'ORIGINAL_POLICY_DRIFT',
    );
    const caMeta = aws(['secretsmanager', 'describe-secret', '--secret-id', secretArn]);
    demand(caMeta.ARN === secretArn && caMeta.KmsKeyId === keyArn, 'CA_METADATA_MISMATCH');
    demand(
      aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName], 'esgiot-readonly', true) ===
        null,
      'TEMPORARY_POLICY_ALREADY_PRESENT',
    );
    demand(
      aws(['lambda', 'get-function-configuration', '--function-name', functionName], 'esgiot-readonly', true) === null,
      'DIAGNOSTIC_FUNCTION_ALREADY_PRESENT',
    );
    const worker = aws([
      'lambda',
      'get-function-configuration',
      '--function-name',
      'fdp-test-onboarding-provisioning',
      '--query',
      '{Role:Role,Runtime:Runtime,LoggingConfig:LoggingConfig}',
    ]);
    demand(
      worker.Role === roleArn &&
        worker.Runtime === 'nodejs24.x' &&
        worker.LoggingConfig.LogGroup === '/aws/lambda/fdp-test-onboarding-provisioning',
      'WORKER_CONFIGURATION_DRIFT',
    );
    const domain = aws([
      'apigatewayv2',
      'get-domain-name',
      '--domain-name',
      'device-api.bio-nexa.com',
      '--query',
      'MutualTlsAuthentication',
    ]);
    demand(
      domain.TruststoreUri === `s3://fdp-test-mtls-truststore-${account}/truststore/ca-bundle.pem` &&
        /^[A-Za-z0-9._-]{1,256}$/.test(domain.TruststoreVersion ?? ''),
      'TRUSTSTORE_REFERENCE_INVALID',
    );
    const trustPath = join(dir, 'truststore.pem');
    const publicObject = aws([
      's3api',
      'get-object',
      '--bucket',
      `fdp-test-mtls-truststore-${account}`,
      '--key',
      'truststore/ca-bundle.pem',
      '--version-id',
      domain.TruststoreVersion,
      trustPath,
    ]);
    const trust = readFileSync(trustPath);
    demand(!trust.includes('PRIVATE KEY') && trust.length < 65536, 'TRUSTSTORE_CONTENT_INVALID');
    receipt.truststore = {
      uri: domain.TruststoreUri,
      version: domain.TruststoreVersion,
      sha256: hash(trust),
      etag: publicObject.ETag,
    };
    writeFileSync(join(dir, 'diagnostic.mjs'), source);
    const handler = `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { diagnoseCaChain } from './diagnostic.mjs';
const client = new SecretsManagerClient({ region: '${region}', maxAttempts: 1 });
export const handler = async (event) => {
 if (event?.operation !== 'READ_ONLY_CA_CHAIN' || event.requestNonce !== '${nonce}') return {completed:false,errorCode:'INVALID_DIAGNOSTIC_REQUEST'};
 if (createHash('sha256').update(readFileSync(new URL('./diagnostic.mjs',import.meta.url))).digest('hex') !== '${sourceHash}') return {completed:false,errorCode:'SOURCE_MISMATCH'};
 let response;
 try {
  response = await client.send(new GetSecretValueCommand({ SecretId: '${secretArn}', VersionStage: 'AWSCURRENT' }), { abortSignal: AbortSignal.timeout(10000) });
  const result = diagnoseCaChain(response.SecretString, readFileSync(new URL('./truststore.pem',import.meta.url),'utf8'));
  return { ...result, requestNonce: '${nonce}', sourceHash: '${sourceHash}', secretVersionId: response.VersionId, diagnosedAt: new Date().toISOString() };
 } catch { return {completed:false,errorCode:'AWS_SECRET_READ_OR_DIAGNOSTIC_FAILED', requestNonce:'${nonce}'}; }
 finally { if(response) {response.SecretString=undefined;response.SecretBinary=undefined;} }
};
`;
    writeFileSync(join(dir, 'handler.mjs'), handler);
    receipt.handlerSourceBase64 = Buffer.from(handler).toString('base64');
    receipt.handlerHash = hash(handler);
    const zipped = spawnSync(
      'python3',
      [
        '-c',
        "import zipfile,sys,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/'diagnostic.zip','w',zipfile.ZIP_DEFLATED); [z.write(p/n,n) for n in ['diagnostic.mjs','handler.mjs','truststore.pem']]; z.close()",
        dir,
      ],
      { encoding: 'utf8' },
    );
    demand(zipped.status === 0, 'ZIP_PREPARATION_FAILED');
    zipSha = createHash('sha256')
      .update(readFileSync(join(dir, 'diagnostic.zip')))
      .digest('base64');
    receipt.codeSha256 = zipSha;
    save();
    permissionAttempted = true;
    aws(
      [
        'iam',
        'put-role-policy',
        '--role-name',
        roleName,
        '--policy-name',
        policyName,
        '--policy-document',
        'file://' + policyPath,
      ],
      'esgiot-infra',
    );
    demand(
      JSON.stringify(
        aws(['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName]).PolicyDocument,
      ) === JSON.stringify(approved),
      'CA_POLICY_READBACK_MISMATCH',
    );
    receipt.temporaryCaPolicyApplied = true;
    save();
    creationAttempted = true;
    const created = aws(
      [
        'lambda',
        'create-function',
        '--function-name',
        functionName,
        '--runtime',
        'nodejs24.x',
        '--role',
        roleArn,
        '--handler',
        'handler.handler',
        '--zip-file',
        'fileb://' + join(dir, 'diagnostic.zip'),
        '--timeout',
        '20',
        '--memory-size',
        '128',
        '--logging-config',
        JSON.stringify({ LogFormat: 'JSON', LogGroup: worker.LoggingConfig.LogGroup }),
        '--description',
        'QA09 one-shot read-only CA chain metadata; no Secret or business writes',
        '--tags',
        JSON.stringify({ 'fdp:env': 'test', 'fdp:project': 'food-digester-platform', 'fdp:task': 'QA-09' }),
        '--publish',
      ],
      'esgiot-infra',
    );
    demand(
      created.CodeSha256 === zipSha && created.Role === roleArn && created.Version === '1',
      'CREATED_FUNCTION_MISMATCH',
    );
    receipt.createdFunctionVersion = created.Version;
    save();
    let config;
    for (let i = 0; i < 30; i++) {
      config = aws(['lambda', 'get-function-configuration', '--function-name', functionName, '--qualifier', '1']);
      if (config.State === 'Active') break;
      demand(config.State !== 'Failed', 'DIAGNOSTIC_FUNCTION_FAILED');
      await pause(2000);
    }
    demand(
      config.State === 'Active' && config.CodeSha256 === zipSha && config.Role === roleArn,
      'DIAGNOSTIC_FUNCTION_NOT_VERIFIED',
    );
    const payload = join(dir, 'payload.json');
    writeFileSync(payload, JSON.stringify({ operation: 'READ_ONLY_CA_CHAIN', requestNonce: nonce }));
    const responsePath = join(dir, 'response.json');
    const invocation = aws(
      [
        'lambda',
        'invoke',
        '--function-name',
        functionName,
        '--qualifier',
        '1',
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        'file://' + payload,
        responsePath,
      ],
      'esgiot-infra',
    );
    demand(
      !invocation.FunctionError && invocation.StatusCode === 200 && invocation.ExecutedVersion === '1',
      'DIAGNOSTIC_INVOCATION_FAILED',
    );
    const result = JSON.parse(readFileSync(responsePath));
    demand(
      result.requestNonce === nonce &&
        result.sourceHash === sourceHash &&
        result.completed &&
        result.schema === 'fdp-qa09-ca-chain/v1',
      'DIAGNOSTIC_RESULT_INVALID',
    );
    demand(
      !/-----BEGIN|caPrivateKeyPem"\s*:|caCertificatePem"\s*:/.test(JSON.stringify(result)),
      'DIAGNOSTIC_OUTPUT_REJECTED',
    );
    receipt.invocation = invocation;
    receipt.result = result;
    receipt.gate = 'PASS';
    save();
  } catch (error) {
    receipt.gate = 'FAIL';
    receipt.errorCode = /^[A-Z0-9_-]{1,120}$/.test(error.message ?? '') ? error.message : 'DIAGNOSTIC_EXECUTION_FAILED';
    save();
  } finally {
    if (creationAttempted) {
      try {
        const current = aws(
          ['lambda', 'get-function-configuration', '--function-name', functionName],
          'esgiot-readonly',
          true,
        );
        if (current) {
          demand(current.Role === roleArn && current.CodeSha256 === zipSha, 'FUNCTION_CLEANUP_SCOPE_MISMATCH');
          aws(['lambda', 'delete-function', '--function-name', functionName], 'esgiot-infra');
        }
        demand(
          aws(['lambda', 'get-function-configuration', '--function-name', functionName], 'esgiot-readonly', true) ===
            null,
          'DIAGNOSTIC_FUNCTION_STILL_PRESENT',
        );
        receipt.cleanup.push({ type: 'diagnostic-function', result: 'PASS' });
      } catch {
        receipt.cleanup.push({ type: 'diagnostic-function', result: 'FAIL' });
        receipt.gate = 'FAIL';
      }
      save();
    }
    if (permissionAttempted) {
      try {
        const current = aws(
          ['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName],
          'esgiot-readonly',
          true,
        );
        if (current) {
          demand(
            JSON.stringify(current.PolicyDocument) === JSON.stringify(approved),
            'CA_POLICY_CLEANUP_SCOPE_MISMATCH',
          );
          aws(['iam', 'delete-role-policy', '--role-name', roleName, '--policy-name', policyName], 'esgiot-infra');
        }
        demand(
          aws(
            ['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName],
            'esgiot-readonly',
            true,
          ) === null,
          'CA_POLICY_STILL_PRESENT',
        );
        receipt.cleanup.push({ type: 'temporary-ca-policy', result: 'PASS' });
      } catch {
        receipt.cleanup.push({ type: 'temporary-ca-policy', result: 'FAIL' });
        receipt.gate = 'FAIL';
      }
      save();
    }
    if (originalPolicy) {
      try {
        demand(
          JSON.stringify(
            aws([
              'iam',
              'get-role-policy',
              '--role-name',
              roleName,
              '--policy-name',
              'OnboardingProvisioningFnServiceRoleDefaultPolicyFF905558',
            ]).PolicyDocument,
          ) === JSON.stringify(originalPolicy),
          'ORIGINAL_POLICY_CHANGED',
        );
        demand(
          aws(['iam', 'get-role', '--role-name', roleName]).Role.PermissionsBoundary.PermissionsBoundaryArn ===
            `arn:aws:iam::${account}:policy/FDP-ServiceBoundary`,
          'BOUNDARY_CHANGED',
        );
        receipt.cleanup.push({ type: 'original-worker-policy-and-boundary', result: 'PASS' });
      } catch {
        receipt.cleanup.push({ type: 'original-worker-policy-and-boundary', result: 'FAIL' });
        receipt.gate = 'FAIL';
      }
    }
    rmSync(dir, { recursive: true, force: true });
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2]).then((r) => {
    console.log(
      JSON.stringify({ gate: r.gate, errorCode: r.errorCode, findings: r.result?.findings, cleanup: r.cleanup }),
    );
    process.exitCode = r.gate === 'PASS' ? 0 : 1;
  });
