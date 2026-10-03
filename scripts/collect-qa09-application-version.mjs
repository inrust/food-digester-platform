import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const ACCEPTANCE_COMMIT = 'e759626a3e965cd9c0330b8e73bc713c0386d7de';
export const EXECUTOR_BASELINE = 'e759626a3e965cd9c0330b8e73bc713c0386d7de';
function command(name, args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(name, args, { encoding: 'utf8', timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0) return JSON.parse(r.stdout);
  }
  throw Error('VERSION_READ_FAILED');
}
const aws = (args) =>
  command('aws', [
    ...args,
    '--profile',
    'esgiot-readonly',
    '--region',
    'ap-southeast-1',
    '--output',
    'json',
    '--no-cli-pager',
  ]);
export async function collect(output, runtimeOnly = false, reusePassed = false) {
  const prior = reusePassed ? JSON.parse(readFileSync(output)) : null;
  const receipt = {
    task: 'QA-09',
    scope: 'CURRENT_APPLICATION_VERSION',
    sourceCommit: ACCEPTANCE_COMMIT,
    accountId: '065986019555',
    region: 'ap-southeast-1',
    stackName: 'fdp-test-app',
    collectedAt: new Date().toISOString(),
    gate: 'BLOCKED',
    blockers: [],
    lambdaArtifacts: [],
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  if (aws(['sts', 'get-caller-identity']).Account !== receipt.accountId) throw Error('WRONG_ACCOUNT');
  receipt.pendingDeployment = command('gh', ['run', 'view', '37078759214', '--json', 'status,conclusion,headSha,url']);
  const paths = [
    'apps',
    'packages',
    'contracts',
    'infra',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.nvmrc',
    'scripts/esgiot-cdk.mjs',
  ];
  receipt.applicationTreeHashes = paths.map((path) => {
    const r = spawnSync('git', ['rev-parse', `${ACCEPTANCE_COMMIT}:${path}`, `${EXECUTOR_BASELINE}:${path}`], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw Error('APPLICATION_TREE_READ_FAILED');
    const [deployed, baseline] = r.stdout.trim().split('\n');
    return { path, deployed, baseline, matches: deployed === baseline };
  });
  if (receipt.applicationTreeHashes.some((t) => !t.matches))
    receipt.blockers.push('CURRENT_AND_REQUESTED_APPLICATION_TREES_DIFFER');
  receipt.executorBaseline = EXECUTOR_BASELINE;
  receipt.github = command('gh', ['run', 'view', '37078759214', '--json', 'status,conclusion,headSha,url,jobs']);
  receipt.ci = command('gh', [
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--commit',
    ACCEPTANCE_COMMIT,
    '--limit',
    '1',
    '--json',
    'status,conclusion,headSha,url',
  ])[0];
  receipt.stack = aws([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    receipt.stackName,
    '--query',
    'Stacks[0].{status:StackStatus,updated:LastUpdatedTime}',
  ]);
  receipt.amplify = aws([
    'amplify',
    'list-jobs',
    '--app-id',
    'd29sdr89i4zl0',
    '--branch-name',
    'main',
    '--max-results',
    '3',
    '--query',
    'jobSummaries[].{jobId:jobId,commitId:commitId,status:status,startTime:startTime,endTime:endTime}',
  ]);
  if (
    receipt.github.headSha !== ACCEPTANCE_COMMIT ||
    receipt.github.status !== 'completed' ||
    receipt.github.conclusion !== 'success'
  )
    receipt.blockers.push('EXACT_COMMIT_DEPLOY_WORKFLOW_NOT_SUCCESSFUL');
  if (receipt.ci.headSha !== ACCEPTANCE_COMMIT || receipt.ci.conclusion !== 'success')
    receipt.blockers.push('EXACT_COMMIT_CI_NOT_SUCCESSFUL');
  if (receipt.stack.status !== 'UPDATE_COMPLETE') receipt.blockers.push('STACK_NOT_UPDATE_COMPLETE');
  if (receipt.amplify[0]?.commitId !== EXECUTOR_BASELINE || receipt.amplify[0]?.status !== 'SUCCEED')
    receipt.blockers.push('EXACT_COMMIT_ADMIN_WEB_NOT_SUCCEEDED');
  if (receipt.blockers.length) {
    save();
    return receipt;
  }
  const template = aws(['cloudformation', 'get-template', '--stack-name', receipt.stackName]).TemplateBody;
  const resources = aws([
    'cloudformation',
    'list-stack-resources',
    '--stack-name',
    receipt.stackName,
  ]).StackResourceSummaries;
  const execute = promisify(execFile);
  const awsAsync = async (args) =>
    JSON.parse(
      (
        await execute(
          'aws',
          [...args, '--profile', 'esgiot-readonly', '--region', receipt.region, '--output', 'json', '--no-cli-pager'],
          { timeout: 45000, maxBuffer: 1048576 },
        )
      ).stdout,
    );
  const functions = resources.filter((r) => r.ResourceType === 'AWS::Lambda::Function');
  const tasks = [];
  for (const resource of functions) {
    const code = template.Resources[resource.LogicalResourceId]?.Properties?.Code;
    if (code?.S3Bucket !== 'fdp-test-cdk-assets-065986019555-ap-southeast-1' || !/^[a-f0-9]{64}\.zip$/.test(code.S3Key))
      throw Error('UNEXPECTED_CODE_ASSET');
    const config = aws([
      'lambda',
      'get-function-configuration',
      '--function-name',
      resource.PhysicalResourceId,
      '--query',
      '{name:FunctionName,codeSha256:CodeSha256,lastModified:LastModified,state:State,lastUpdateStatus:LastUpdateStatus,revisionId:RevisionId,runtime:Runtime}',
    ]);
    if (runtimeOnly) {
      receipt.lambdaArtifacts.push({
        ...config,
        logicalId: resource.LogicalResourceId,
        s3Bucket: code.S3Bucket,
        s3Key: code.S3Key,
        runtimeHealthy: config.state === 'Active' && config.lastUpdateStatus === 'Successful',
      });
      continue;
    }
    const old = prior?.lambdaArtifacts?.find(
      (a) =>
        a.name === config.name &&
        a.matches === true &&
        a.artifactSha256 === config.codeSha256 &&
        a.s3Key === code.S3Key &&
        a.s3Bucket === code.S3Bucket,
    );
    if (old) {
      receipt.lambdaArtifacts.push({ ...old, ...config, reusedVerifiedBytes: true });
      continue;
    }
    const head = aws(['s3api', 'head-object', '--bucket', code.S3Bucket, '--key', code.S3Key]);
    if (!Number.isInteger(head.ContentLength) || head.ContentLength < 1 || head.ContentLength > 33554432)
      throw Error('INVALID_CODE_ASSET_SIZE');
    const item = {
      ...config,
      logicalId: resource.LogicalResourceId,
      s3Bucket: code.S3Bucket,
      s3Key: code.S3Key,
      sourceVersion: head.VersionId ?? null,
      contentLength: head.ContentLength,
      rangeBytes: 262144,
      artifactSha256: null,
      matches: false,
      chunks: [],
    };
    receipt.lambdaArtifacts.push(item);
    for (let offset = 0; offset < head.ContentLength; offset += 262144) {
      const start = offset,
        end = Math.min(offset + 262143, head.ContentLength - 1);
      tasks.push(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qa09-code-range-'));
        try {
          const path = join(dir, 'chunk');
          const args = [
            's3api',
            'get-object',
            '--bucket',
            code.S3Bucket,
            '--key',
            code.S3Key,
            '--range',
            `bytes=${start}-${end}`,
            ...(head.VersionId ? ['--version-id', head.VersionId] : []),
            path,
          ];
          let metadata;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              metadata = await awsAsync(args);
              break;
            } catch (error) {
              if (attempt === 2) throw error;
            }
          }
          const bytes = readFileSync(path);
          if (
            metadata.ContentRange !== `bytes ${start}-${end}/${head.ContentLength}` ||
            bytes.length !== end - start + 1 ||
            (head.VersionId && metadata.VersionId !== head.VersionId)
          )
            throw Error('CODE_RANGE_MISMATCH');
          item.chunks.push({ start, bytes });
        } catch {
          item.rangeReadFailed = true;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
  if (runtimeOnly) {
    receipt.applicationVersionGate =
      receipt.lambdaArtifacts.length === functions.length &&
      receipt.lambdaArtifacts.every((a) => a.runtimeHealthy && /^[A-Za-z0-9+/]{43}=$/.test(a.codeSha256))
        ? 'PASS'
        : 'BLOCKED';
    receipt.artifactByteGate = 'RUNNING';
    receipt.gate = 'PARTIAL';
    receipt.byteReceipt = output.replace('application-runtime-version', 'application-version');
    save();
    return receipt;
  }
  let next = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < tasks.length) {
        const i = next++;
        await tasks[i]();
        completed++;
        if (completed % 20 === 0) console.log(`Code asset ranges collected: ${completed}/${tasks.length}`);
      }
    }),
  );
  for (const item of receipt.lambdaArtifacts) {
    if (item.reusedVerifiedBytes) continue;
    const chunks = item.chunks.sort((a, b) => a.start - b.start);
    const byteCount = chunks.reduce((n, c) => n + c.bytes.length, 0);
    if (!item.rangeReadFailed && byteCount === item.contentLength) {
      const sha = createHash('sha256');
      for (const c of chunks) sha.update(c.bytes);
      item.artifactSha256 = sha.digest('base64');
    }
    item.rangeCount = chunks.length;
    delete item.chunks;
    item.matches =
      item.artifactSha256 === item.codeSha256 && item.state === 'Active' && item.lastUpdateStatus === 'Successful';
    if (!item.matches) receipt.blockers.push('LAMBDA_TEMPLATE_ARTIFACT_UNVERIFIED:' + item.name);
  }
  if (receipt.lambdaArtifacts.length < 10) receipt.blockers.push('LAMBDA_INVENTORY_INCOMPLETE');
  receipt.binding =
    'Successful exact-commit GitHub OIDC/CDK workflow + deployed CloudFormation asset + S3 ZIP bytes equal current Lambda CodeSha256; S3 immutable versions read in bounded ranges and reassembled for SHA256; no app build commit environment variable exists.';
  receipt.gate = receipt.blockers.length ? 'BLOCKED' : 'PASS';
  save();
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  collect(process.argv[2], process.argv[3] === '--runtime-only', process.argv[3] === '--retry-unverified')
    .then((r) => {
      console.log(JSON.stringify({ gate: r.gate, blockers: r.blockers, lambdaCount: r.lambdaArtifacts.length }));
      process.exitCode = r.gate === 'PASS' || r.applicationVersionGate === 'PASS' ? 0 : 1;
    })
    .catch(() => {
      console.error('QA09_VERSION_COLLECTION_FAILED');
      process.exitCode = 1;
    });
