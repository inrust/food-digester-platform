import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile),
  role = 'arn:aws:iam::065986019555:role/fdp-test-replay-role';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
export function validateOwnVersionPlan(plan) {
  if (
    !/^qa09-[a-f0-9]{16}$/.test(plan?.prefix ?? '') ||
    plan.customerIds?.length !== 2 ||
    new Set(plan.customerIds).size !== 2 ||
    plan.customerIds.some((id) => !/^[a-f0-9-]{36}$/.test(id)) ||
    !Array.isArray(plan.objects) ||
    plan.objects.length !== 10 ||
    new Set(plan.objects.map((o) => o.key)).size !== 10 ||
    plan.objects.some(
      (o) =>
        !o.versionId ||
        !plan.customerIds.some((id) =>
          new RegExp(
            `^raw/topic_type=(telemetry|alarm|event|tamper|ack)/customer_id=${id}/year=[0-9]{4}/month=[0-9]{2}/day=[0-9]{2}/hour=[0-9]{2}/part-[a-f0-9]{16}\\.(json\\.gz|manifest\\.json)$`,
          ).test(o.key),
        ),
    )
  )
    throw Error('EXACT_TEN_OWN_IMMUTABLE_ARCHIVE_FILES_REQUIRED');
}
export async function readOwnVersions(plan, output) {
  validateOwnVersionPlan(plan);
  const nonce = randomBytes(16).toString('hex'),
    name = 'fdp-test-qa09-archive-' + nonce.slice(0, 16),
    dir = mkdtempSync(join(tmpdir(), 'qa09-versions-'));
  const r = {
    scope: 'EXISTING_REPLAY_ROLE_READ_ONLY_OWN_IMMUTABLE_ARCHIVES',
    prefix: plan.prefix,
    functionName: name,
    roleArn: role,
    nonce,
    plan,
    planSha256: hash(JSON.stringify(plan)),
    iamKmsWrites: 0,
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    cleanup: [],
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const aws = async (args, profile = 'esgiot-readonly', absent = false) => {
    try {
      const x = await exec(
        'aws',
        [
          ...args,
          '--profile',
          profile,
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '5',
          '--cli-read-timeout',
          '120',
        ],
        { timeout: 150000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
      );
      return x.stdout.trim() ? JSON.parse(x.stdout) : {};
    } catch (e) {
      if (absent && e.stderr?.includes('ResourceNotFoundException')) return null;
      throw Error('OWN_VERSION_READER_AWS_FAILED');
    }
  };
  const policy = async () =>
    (
      await aws([
        'iam',
        'get-role-policy',
        '--role-name',
        'fdp-test-replay-role',
        '--policy-name',
        'ReplayFnServiceRoleDefaultPolicy676F95BC',
      ])
    ).PolicyDocument;
  let creationAttempted = false;
  save();
  try {
    const existing = (await aws(['iam', 'get-role', '--role-name', 'fdp-test-replay-role'])).Role;
    if (
      existing.Arn !== role ||
      existing.PermissionsBoundary?.PermissionsBoundaryArn !== 'arn:aws:iam::065986019555:policy/FDP-ServiceBoundary'
    )
      throw Error('EXISTING_READER_ROLE_BOUNDARY_REQUIRED');
    r.originalRolePolicySha256 = hash(JSON.stringify(await policy()));
    const source = `import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
const plan=${JSON.stringify(plan)}; const client=new S3Client({region:'ap-southeast-1',maxAttempts:1});
export const handler=async event=>{if(event?.nonce!==${JSON.stringify(nonce)})return {gate:'INVALID_NONCE'}; const objects=[];for(const o of plan.objects){const response=await client.send(new GetObjectCommand({Bucket:'fdp-test-raw-065986019555',Key:o.key,VersionId:o.versionId}),{abortSignal:AbortSignal.timeout(10000)});if(response.VersionId!==o.versionId||!response.ContentLength||response.ContentLength>65536)throw Error('OWN_VERSION_SIZE_OR_ID_MISMATCH');const body=Buffer.from(await response.Body.transformToByteArray());if(body.length!==response.ContentLength)throw Error('OWN_VERSION_BYTES_MISMATCH');objects.push({...o,bodyBase64:body.toString('base64')});}return {gate:'PASS',nonce:${JSON.stringify(nonce)},planSha256:${JSON.stringify(r.planSha256)},objects};};`;
    writeFileSync(join(dir, 'handler.mjs'), source);
    r.handlerSha256 = hash(source);
    r.handlerSourceBase64 = Buffer.from(source).toString('base64');
    save();
    await exec('python3', [
      '-c',
      "import pathlib,sys,zipfile; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/'reader.zip','w',zipfile.ZIP_DEFLATED); z.write(p/'handler.mjs','handler.mjs');z.close()",
      dir,
    ]);
    r.codeSha256 = createHash('sha256')
      .update(readFileSync(join(dir, 'reader.zip')))
      .digest('base64');
    creationAttempted = true;
    save();
    const created = await aws(
      [
        'lambda',
        'create-function',
        '--function-name',
        name,
        '--runtime',
        'nodejs24.x',
        '--role',
        role,
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
        'QA09 existing-role read-only own archive versions; no IAM or business writes',
        '--tags',
        JSON.stringify({ 'fdp:env': 'test', 'fdp:task': 'QA-09' }),
        '--publish',
      ],
      'esgiot-infra',
    );
    if (created.Role !== role || created.CodeSha256 !== r.codeSha256 || created.Version !== '1')
      throw Error('PUBLISHED_READER_CODE_BINDING_REQUIRED');
    let active;
    for (let i = 0; i < 30; i++) {
      active = await aws(['lambda', 'get-function-configuration', '--function-name', name]);
      if (active.State === 'Active') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (active?.State !== 'Active' || active.CodeSha256 !== r.codeSha256 || active.Role !== role)
      throw Error('READER_NOT_ACTIVE');
    writeFileSync(join(dir, 'input.json'), JSON.stringify({ nonce }));
    const metadata = await aws(
      [
        'lambda',
        'invoke',
        '--function-name',
        name,
        '--qualifier',
        '1',
        '--payload',
        'fileb://' + join(dir, 'input.json'),
        join(dir, 'result.json'),
      ],
      'esgiot-infra',
    );
    if (metadata.StatusCode !== 200 || metadata.FunctionError || metadata.ExecutedVersion !== '1')
      throw Error('READER_INVOCATION_NOT_TERMINAL_SUCCESS');
    r.invocation = { status: metadata.StatusCode, executedVersion: metadata.ExecutedVersion };
    r.result = JSON.parse(readFileSync(join(dir, 'result.json')));
    save();
    if (
      r.result.gate !== 'PASS' ||
      r.result.nonce !== nonce ||
      r.result.planSha256 !== r.planSha256 ||
      r.result.objects.length !== 10 ||
      r.result.objects.some((o, i) => o.key !== plan.objects[i].key || o.versionId !== plan.objects[i].versionId)
    )
      throw Error('READER_RESULT_BINDING_REQUIRED');
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'OWN_VERSION_READER_FAILED';
  } finally {
    if (creationAttempted)
      try {
        const c = await aws(['lambda', 'get-function-configuration', '--function-name', name], 'esgiot-readonly', true);
        if (c) {
          demand(c.Role === role && c.CodeSha256 === r.codeSha256, 'READER_CLEANUP_CODE_DRIFT');
          await aws(['lambda', 'delete-function', '--function-name', name], 'esgiot-infra');
        }
        demand(
          !(await aws(['lambda', 'get-function-configuration', '--function-name', name], 'esgiot-readonly', true)),
          'READER_REMAINS',
        );
        r.cleanup.push({ type: 'exact-temporary-reader-deleted', result: 'PASS' });
      } catch {
        r.cleanup.push({ type: 'exact-temporary-reader-deleted', result: 'FAIL' });
        r.gate = 'FAIL';
      }
    try {
      demand(
        r.originalRolePolicySha256 && hash(JSON.stringify(await policy())) === r.originalRolePolicySha256,
        'ROLE_POLICY_DRIFT',
      );
      r.cleanup.push({ type: 'existing-role-policy-unchanged', result: 'PASS' });
    } catch {
      r.cleanup.push({ type: 'existing-role-policy-unchanged', result: 'FAIL' });
      r.gate = 'FAIL';
    }
    rmSync(dir, { recursive: true, force: true });
    r.finishedAt = new Date().toISOString();
    save();
  }
  if (r.gate !== 'PASS') throw Error('OWN_VERSION_READER_FAILED');
  return r;
}
