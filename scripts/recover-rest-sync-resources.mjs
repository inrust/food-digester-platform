/** Recover only an exact failed own-run ledger; no business setup or shared service mutation. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { validateScope } from './rest-sync-fixture.mjs';
import { ownArchivePrefix } from './rest-sync-evidence.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
export async function main(parentPath, output) {
  const parent = JSON.parse(readFileSync(parentPath));
  validateScope(parent.scope);
  if (
    process.env.FDP_REST_SYNC_RECOVERY !== '1' ||
    parent.gate !== 'FAIL' ||
    parent.mode !== 'REAL_ASSIGNED_REST_SYNC_NO_DB_SEED' ||
    !parent.finishedAt ||
    parent.target.account !== '065986019555' ||
    parent.target.region !== 'ap-southeast-1' ||
    !parent.fixture?.name ||
    parent.fixture.name !== 'fdp-test-qa09-' + parent.scope.serial
  )
    throw Error('FAILED_OWN_LEDGER_REQUIRED');
  const dir = dirname(resolve(output)),
    r = {
      scope: parent.scope,
      parentSha256: sha(readFileSync(parentPath)),
      sourceHashes: Object.fromEntries(
        [
          'scripts/recover-rest-sync-resources.mjs',
          'scripts/rest-sync-fixture.mjs',
          'scripts/rest-sync-evidence.mjs',
        ].map((f) => [f, sha(readFileSync(f))]),
      ),
      startedAt: new Date().toISOString(),
      operations: [],
      gate: 'RUNNING',
    };
  mkdirSync(dir, { recursive: true });
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const aws = (s, o, a = [], read = false) => {
    try {
      const v = execFileSync(
        'aws',
        [
          s,
          o,
          ...a,
          '--profile',
          read ? 'esgiot-readonly' : 'esgiot-infra',
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '5',
          '--cli-read-timeout',
          '35',
        ],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return v.trim() ? JSON.parse(v) : {};
    } catch (e) {
      throw Error(`${s}:${o}:${String(e.stderr ?? '').match(/\(([A-Za-z0-9]+)\)/)?.[1] ?? e.code ?? 'FAILED'}`);
    }
  };
  const name = parent.fixture.name;
  let created = false,
    count = 0;
  const db = (action) => {
    const stem = 'recovery-' + String(++count).padStart(3, '0') + '-' + action,
      input = resolve(dir, stem + '-input.json'),
      out = resolve(dir, stem + '-result.json');
    writeFileSync(input, JSON.stringify({ action }));
    const meta = aws('lambda', 'invoke', [
      '--function-name',
      name,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--payload',
      'file://' + input,
      out,
    ]);
    const value = JSON.parse(readFileSync(out));
    r.operations.push({ action, at: new Date().toISOString(), file: stem + '-result.json' });
    save();
    if (meta.FunctionError || value.error || value.scope !== parent.scope.serial)
      throw Error('RECOVERY_DB_' + JSON.stringify(value.error ?? meta.FunctionError ?? 'SCOPE'));
    return value.result;
  };
  try {
    if (aws('sts', 'get-caller-identity').Account !== parent.target.account) throw Error('WRONG_ACCOUNT');
    const cfg = aws(
        'lambda',
        'get-function-configuration',
        ['--function-name', 'fdp-test-replay', '--query', '{Role:Role,VpcConfig:VpcConfig}'],
        true,
      ),
      vars = aws(
        'lambda',
        'get-function-configuration',
        ['--function-name', 'fdp-test-ingestion', '--query', 'Environment.Variables'],
        true,
      );
    const ld = resolve(dir, 'recovery-lambda');
    mkdirSync(ld, { recursive: true });
    await build({
      entryPoints: ['scripts/rest-sync-fixture.mjs'],
      outfile: ld + '/index.cjs',
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: ['@aws-sdk/client-secrets-manager', 'pg-native'],
      logLevel: 'silent',
    });
    writeFileSync(ld + '/rds-ca-bundle.pem', readFileSync(resolve(dirname(parentPath), 'lambda/rds-ca-bundle.pem')));
    execFileSync('zip', ['-q', resolve(dir, 'recovery-fixture.zip'), 'index.cjs', 'rds-ca-bundle.pem'], { cwd: ld });
    r.fixtureZipSha256 = sha(readFileSync(resolve(dir, 'recovery-fixture.zip')));
    save();
    aws('lambda', 'create-function', [
      '--function-name',
      name,
      '--runtime',
      'nodejs24.x',
      '--role',
      cfg.Role,
      '--handler',
      'index.handler',
      '--timeout',
      '30',
      '--memory-size',
      '256',
      '--zip-file',
      'fileb://' + resolve(dir, 'recovery-fixture.zip'),
      '--vpc-config',
      JSON.stringify({ SubnetIds: cfg.VpcConfig.SubnetIds, SecurityGroupIds: cfg.VpcConfig.SecurityGroupIds }),
      '--environment',
      JSON.stringify({
        Variables: { DB_SECRET_ARN: vars.DB_SECRET_ARN, REST_SYNC_SCOPE: JSON.stringify(parent.scope) },
      }),
    ]);
    created = true;
    for (let i = 0; i < 40; i++) {
      const s = aws('lambda', 'get-function-configuration', ['--function-name', name, '--query', 'State'], true);
      if (s === 'Active') break;
      if (s === 'Failed') throw Error('RECOVERY_OBSERVER_FAILED');
      await new Promise((r) => setTimeout(r, 2000));
    }
    let state;
    const until = Date.now() + 180000;
    do {
      state = db('observe');
      if (
        !state.jobs.some((j) => ['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)) &&
        state.outbox.every((o) => ['PUBLISHED', 'FAILED'].includes(o.status))
      )
        break;
      if (Date.now() > until) throw Error('RECOVERY_NOT_QUIESCENT');
      await new Promise((r) => setTimeout(r, 5000));
    } while (Date.now() < until);
    r.before = state;
    save();
    for (const c of state.certificates) {
      if (!parent.certificates.some((x) => x.id === c.id)) throw Error('UNKNOWN_CERTIFICATE');
      const arn = 'arn:aws:iot:ap-southeast-1:065986019555:cert/' + c.id;
      const things = aws('iot', 'list-principal-things', ['--principal', arn], true).things;
      if (things.some((t) => t !== parent.deviceId)) throw Error('FOREIGN_THING');
      aws('iot', 'update-certificate', ['--certificate-id', c.id, '--new-status', 'INACTIVE']);
      const policies = aws('iot', 'list-attached-policies', ['--target', arn], true).policies;
      for (const p of policies) {
        if (p.policyName !== 'fdp-device-' + parent.deviceId) throw Error('FOREIGN_POLICY');
        aws('iot', 'detach-policy', ['--policy-name', p.policyName, '--target', arn]);
      }
      for (const thing of things) aws('iot', 'detach-thing-principal', ['--thing-name', thing, '--principal', arn]);
      aws('iot', 'delete-certificate', ['--certificate-id', c.id]);
      for (const p of policies) {
        if (aws('iot', 'list-targets-for-policy', ['--policy-name', p.policyName], true).targets?.length)
          throw Error('POLICY_STILL_BOUND');
        aws('iot', 'delete-policy', ['--policy-name', p.policyName]);
      }
    }
    if (state.devices.length) {
      if (state.devices[0].id !== parent.deviceId) throw Error('FOREIGN_DEVICE');
      aws('iot', 'delete-thing', ['--thing-name', parent.deviceId]);
    }
    r.archiveCleanup = [];
    for (const c of state.customers) {
      const prefix = ownArchivePrefix(c.id),
        v = aws(
          's3api',
          'list-object-versions',
          ['--bucket', 'fdp-test-raw-065986019555', '--prefix', prefix, '--max-keys', '100', '--no-paginate'],
          true,
        );
      if (v.IsTruncated) throw Error('ARCHIVE_TOO_LARGE');
      const entries = [...(v.Versions ?? []), ...(v.DeleteMarkers ?? [])];
      for (const item of entries) {
        if (!item.Key.startsWith(prefix) || !item.VersionId) throw Error('FOREIGN_ARCHIVE');
        aws('s3api', 'delete-object', [
          '--bucket',
          'fdp-test-raw-065986019555',
          '--key',
          item.Key,
          '--version-id',
          item.VersionId,
        ]);
      }
      const after = aws(
        's3api',
        'list-object-versions',
        ['--bucket', 'fdp-test-raw-065986019555', '--prefix', prefix, '--max-keys', '100', '--no-paginate'],
        true,
      );
      if (after.IsTruncated || (after.Versions ?? []).length || (after.DeleteMarkers ?? []).length)
        throw Error('ARCHIVE_REMAINS');
      r.archiveCleanup.push({ prefix, deleted: entries.map((v) => ({ key: v.Key, versionId: v.VersionId })), after });
      save();
    }
    r.deleted = db('cleanup').deleted;
    r.parents = db('close-parents').parentsClosed;
    r.after = db('audit-empty');
    if (
      JSON.stringify(r.after.outsideFingerprints) !== JSON.stringify(parent.baseline.outsideFingerprints) ||
      JSON.stringify(r.after.outsideBusinessFingerprints) !==
        JSON.stringify(parent.baseline.outsideBusinessFingerprints)
    )
      throw Error('BASELINE_DRIFT');
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failure = String(e.message).slice(0, 500);
  } finally {
    if (created) {
      try {
        aws('lambda', 'delete-function', ['--function-name', name]);
        r.observerRemoved = true;
      } catch (e) {
        r.gate = 'FAIL';
        r.cleanupFailure = e.message;
      }
    }
    r.finishedAt = new Date().toISOString();
    save();
  }
  console.log(JSON.stringify({ gate: r.gate, scope: r.scope.serial, failure: r.failure ?? null }));
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(...process.argv.slice(2))
    .then((r) => {
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
