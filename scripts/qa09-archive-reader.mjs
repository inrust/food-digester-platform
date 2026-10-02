import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArchivePlan } from './qa09-archive-probe.mjs';
const roleArn = 'arn:aws:iam::065986019555:role/fdp-test-replay-role';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function demand(ok, code) {
  if (!ok) throw Error(code);
}
function aws(args, profile = 'esgiot-readonly', absent = false) {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 150000, maxBuffer: 1048576 },
  );
  if (r.status !== 0) {
    if (absent && /ResourceNotFoundException/.test(r.stderr ?? '')) return null;
    throw Error('ARCHIVE_AWS_OPERATION_FAILED');
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
export async function readOwnArchives(receipt, observation, output) {
  const plan = {
    prefix: receipt.prefix,
    devices: receipt.devices,
    customers: receipt.customers.map((c) => c.id),
    published: receipt.published,
    outbox: observation.outbox
      .map((o) => ({ id: o.id, rawBodySha256: o.rawBodySha256 }))
      .filter((o) => o.rawBodySha256),
  };
  validateArchivePlan(plan);
  const nonce = randomBytes(16).toString('hex'),
    fn = 'fdp-test-qa09-archive-' + nonce.slice(0, 16),
    dir = mkdtempSync(join(tmpdir(), 'qa09-archive-'));
  const source = readFileSync(new URL('./qa09-archive-probe.mjs', import.meta.url));
  const planBytes = Buffer.from(JSON.stringify(plan));
  const r = {
    task: 'QA-09',
    scope: 'AWS_ONLY_OWN_TEN_ARCHIVE_READ',
    prefix: plan.prefix,
    roleArn,
    functionName: fn,
    requestNonce: nonce,
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    sourceHash: hash(source),
    sourceBase64: source.toString('base64'),
    planHash: hash(planBytes),
    plan,
    secretValuesExported: false,
    iamWrites: false,
    cleanup: [],
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  let created = false,
    sha;
  try {
    const role = aws(['iam', 'get-role', '--role-name', 'fdp-test-replay-role']).Role;
    demand(
      role.Arn === roleArn &&
        role.PermissionsBoundary.PermissionsBoundaryArn === 'arn:aws:iam::065986019555:policy/FDP-ServiceBoundary',
      'ARCHIVE_ROLE_DRIFT',
    );
    const originalPolicy = aws([
      'iam',
      'get-role-policy',
      '--role-name',
      'fdp-test-replay-role',
      '--policy-name',
      'ReplayFnServiceRoleDefaultPolicy676F95BC',
    ]).PolicyDocument;
    r.originalRolePolicyHash = hash(JSON.stringify(originalPolicy));
    writeFileSync(join(dir, 'probe.mjs'), source);
    writeFileSync(join(dir, 'scope.json'), planBytes);
    const handler = `import {S3Client,ListObjectsV2Command,GetObjectCommand} from '@aws-sdk/client-s3';
import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {verifyArchiveObjects,validateArchivePlan} from './probe.mjs';
const client=new S3Client({region:'ap-southeast-1',maxAttempts:1});
export const handler=async event=>{if(event?.requestNonce!=='${nonce}')return {completed:false,errorCode:'INVALID_REQUEST'};
try{const bytes=readFileSync(new URL('./scope.json',import.meta.url));if(createHash('sha256').update(bytes).digest('hex')!=='${r.planHash}')throw Error('INVALID_SCOPE');const plan=JSON.parse(bytes);validateArchivePlan(plan);const objects=[],keys=[];
for(const customer of plan.customers)for(const type of ['heartbeat','telemetry']){let token;do{const response=await client.send(new ListObjectsV2Command({Bucket:'fdp-test-raw-065986019555',Prefix:'raw/topic_type='+type+'/customer_id='+customer+'/',ContinuationToken:token}),{abortSignal:AbortSignal.timeout(10000)});for(const item of response.Contents??[])keys.push(item.Key);if(keys.length>200)throw Error('LIMIT');token=response.NextContinuationToken;}while(token);}
for(const key of keys.filter(k=>k.endsWith('.json.gz'))){const response=await client.send(new GetObjectCommand({Bucket:'fdp-test-raw-065986019555',Key:key}),{abortSignal:AbortSignal.timeout(10000)});if(response.ContentLength>1048576)throw Error('LIMIT');objects.push({key,bytes:Buffer.from(await response.Body.transformToByteArray())});}
return {...verifyArchiveObjects(plan,objects),archiveKeys:keys,requestNonce:'${nonce}',sourceHash:'${r.sourceHash}',planHash:'${r.planHash}'};
}catch(error){return {completed:false,errorCode:/^[A-Z_]+$/.test(error.message??'')?error.message:'AWS_ARCHIVE_READ_FAILED',requestNonce:'${nonce}'};}};
`;
    writeFileSync(join(dir, 'handler.mjs'), handler);
    r.handlerHash = hash(handler);
    r.handlerSourceBase64 = Buffer.from(handler).toString('base64');
    const z = spawnSync('python3', [
      '-c',
      "import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/'reader.zip','w',zipfile.ZIP_DEFLATED); [z.write(p/n,n) for n in ['handler.mjs','probe.mjs','scope.json']];z.close()",
      dir,
    ]);
    demand(z.status === 0, 'ARCHIVE_ZIP_FAILED');
    sha = createHash('sha256')
      .update(readFileSync(join(dir, 'reader.zip')))
      .digest('base64');
    r.codeSha256 = sha;
    save();
    created = true;
    const c = aws(
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
        'handler.handler',
        '--zip-file',
        'fileb://' + join(dir, 'reader.zip'),
        '--timeout',
        '120',
        '--memory-size',
        '256',
        '--logging-config',
        JSON.stringify({ LogFormat: 'JSON', LogGroup: '/aws/lambda/fdp-test-replay' }),
        '--description',
        'QA09 read-only exact own archive bytes; no secret or business writes',
        '--tags',
        JSON.stringify({ 'fdp:env': 'test', 'fdp:task': 'QA-09' }),
        '--publish',
      ],
      'esgiot-infra',
    );
    demand(c.Role === roleArn && c.CodeSha256 === sha && c.Version === '1', 'ARCHIVE_FUNCTION_BINDING_FAILED');
    let active;
    for (let i = 0; i < 30; i++) {
      active = aws(['lambda', 'get-function-configuration', '--function-name', fn]);
      if (active.State === 'Active') break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    demand(
      active.State === 'Active' && active.CodeSha256 === sha && active.Role === roleArn,
      'ARCHIVE_FUNCTION_NOT_ACTIVE',
    );
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ requestNonce: nonce }));
    r.invocation = aws(
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
        'file://' + join(dir, 'event.json'),
        join(dir, 'result.json'),
      ],
      'esgiot-infra',
    );
    demand(!r.invocation.FunctionError && r.invocation.ExecutedVersion === '1', 'ARCHIVE_INVOKE_FAILED');
    r.result = JSON.parse(readFileSync(join(dir, 'result.json')));
    save();
    demand(
      r.result.completed &&
        r.result.requestNonce === nonce &&
        r.result.sourceHash === r.sourceHash &&
        r.result.planHash === r.planHash &&
        r.result.allTelemetryArchived,
      'ARCHIVE_READ_NOT_VERIFIED',
    );
    r.gate = 'PASS';
  } catch (error) {
    r.gate = 'FAIL';
    r.errorCode = /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'ARCHIVE_HELPER_FAILED';
  } finally {
    if (created)
      try {
        const c = aws(['lambda', 'get-function-configuration', '--function-name', fn], 'esgiot-readonly', true);
        if (c) {
          demand(c.Role === roleArn && c.CodeSha256 === sha, 'ARCHIVE_CLEANUP_DRIFT');
          aws(['lambda', 'delete-function', '--function-name', fn], 'esgiot-infra');
        }
        demand(
          aws(['lambda', 'get-function-configuration', '--function-name', fn], 'esgiot-readonly', true) === null,
          'ARCHIVE_FUNCTION_REMAINS',
        );
        r.cleanup.push({ type: 'archive-reader-function-deleted', result: 'PASS' });
      } catch {
        r.cleanup.push({ type: 'archive-reader-function-deleted', result: 'FAIL' });
        r.gate = 'FAIL';
      }
    try {
      demand(
        hash(
          JSON.stringify(
            aws([
              'iam',
              'get-role-policy',
              '--role-name',
              'fdp-test-replay-role',
              '--policy-name',
              'ReplayFnServiceRoleDefaultPolicy676F95BC',
            ]).PolicyDocument,
          ),
        ) === r.originalRolePolicyHash,
        'ARCHIVE_ROLE_CHANGED',
      );
      r.cleanup.push({ type: 'original-replay-role-policy-preserved', result: 'PASS' });
    } catch {
      r.cleanup.push({ type: 'original-replay-role-policy-preserved', result: 'FAIL' });
      r.gate = 'FAIL';
    }
    rmSync(dir, { recursive: true, force: true });
    r.finishedAt = new Date().toISOString();
    save();
  }
  demand(r.gate === 'PASS', 'AWS_ARCHIVE_HELPER_FAILED');
  return r;
}
