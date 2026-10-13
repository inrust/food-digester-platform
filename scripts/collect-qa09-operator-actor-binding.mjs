/** Independent read-only mapping of signed Cognito actor sub to the owned database user. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './qa09-reliability-closeout.mjs';
const exec = promisify(execFile),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function bindOwnOperatorActor(parent, r, prep, seed, identity, groups) {
  const own = r.operator,
    p = prep.plan?.ownUser;
  if (
    !/^qa09-[a-f0-9]{16}$/.test(parent.prefix ?? '') ||
    r.prefix !== parent.prefix ||
    r.sourceCommit !== parent.sourceCommit ||
    own?.role !== 'PlatformOperator' ||
    own.email !== parent.prefix + '-h01-platformoperator@example.invalid' ||
    !own.realSrp ||
    p?.userId !== own.userId ||
    p.email !== own.email ||
    p.role !== 'PlatformOperator' ||
    p.customerId !== null ||
    !identity.enabled ||
    identity.status !== 'CONFIRMED' ||
    identity.email !== own.email ||
    identity.subject !== p.cognitoSub ||
    !/^[a-f0-9-]{36}$/.test(identity.subject ?? '') ||
    JSON.stringify(groups) !== JSON.stringify(['PlatformOperator']) ||
    prep.plan.prefix !== parent.prefix ||
    prep.plan.action !== 'business-seed-user' ||
    seed.gate !== 'PASS' ||
    seed.sourceHash !== prep.sourceHash ||
    seed.result?.sourceHash !== prep.sourceHash ||
    seed.result?.prefix !== parent.prefix ||
    seed.result?.action !== 'business-seed-user' ||
    seed.result?.user?.userId !== own.userId ||
    seed.result?.user?.email !== own.email ||
    JSON.stringify(seed.result.user.roles) !== JSON.stringify(['PlatformOperator']) ||
    seed.build?.status !== 'SUCCEEDED' ||
    !seed.build.id?.startsWith('fdp-test-qa09-ten-device-fixtures:') ||
    !r.fixtureBuilds?.some((row) => row.gate === 'PASS' && row.buildId === seed.build.id)
  )
    throw Error('EXACT_REAL_OPERATOR_SUB_MAPPING_REQUIRED');
  return {
    gate: 'PASS_REAL_COGNITO_SUB_TO_OWN_DATABASE_USER',
    prefix: parent.prefix,
    applicationCommit: parent.sourceCommit,
    businessUserId: own.userId,
    actorId: identity.subject,
    email: own.email,
    groups,
    seedBuildId: seed.build.id,
    authActorKind: 'SIGNED_COGNITO_SUB',
    businessUserKind: 'DATABASE_USER_ID',
    awsMutations: 0,
    fullQa09Accepted: false,
  };
}
export async function collectOperatorActorBinding(parentPath, output, { budgetMs = 5400000 } = {}) {
  if (existsSync(output) || budgetMs < 1 || budgetMs > 5400000) throw Error('FRESH_BOUNDED_ACTOR_BINDING_REQUIRED');
  const initial = JSON.parse(readFileSync(parentPath));
  if (!/^qa09-[a-f0-9]{16}$/.test(initial.prefix ?? '')) throw Error('EXACT_OWN_PARENT_REQUIRED');
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const parent = JSON.parse(readFileSync(parentPath)),
      r = existsSync(parentPath + '.reliability.json')
        ? JSON.parse(readFileSync(parentPath + '.reliability.json'))
        : null;
    if (r?.operator?.realSrp) {
      const seedPath = r.fixtureBuilds.find((row) => row.role === 'PlatformOperator')?.receipt;
      if (seedPath !== parentPath + '.seed-PlatformOperator.json') throw Error('EXACT_OWN_SEED_PATH_REQUIRED');
      const read = async (args) =>
        JSON.parse(
          (
            await exec(
              'aws',
              [
                ...args,
                '--profile',
                'esgiot-infra',
                '--region',
                'ap-southeast-1',
                '--output',
                'json',
                '--no-cli-pager',
                '--cli-connect-timeout',
                '3',
                '--cli-read-timeout',
                '8',
              ],
              { timeout: 15000, maxBuffer: 16384, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
            )
          ).stdout,
        );
      const base = ['--user-pool-id', 'ap-southeast-1_hZMX8LpFo', '--username', r.operator.email];
      const identity = await read([
        'cognito-idp',
        'admin-get-user',
        ...base,
        '--query',
        "{enabled:Enabled,status:UserStatus,email:UserAttributes[?Name=='email'].Value|[0],subject:UserAttributes[?Name=='sub'].Value|[0]}",
      ]);
      const groups = await read([
        'cognito-idp',
        'admin-list-groups-for-user',
        ...base,
        '--limit',
        '10',
        '--no-paginate',
        '--query',
        '{groups:Groups[].GroupName,token:NextToken}',
      ]);
      if (groups.token) throw Error('OPERATOR_GROUP_READ_TRUNCATED');
      const prep = JSON.parse(readFileSync(seedPath + '.preparation.json')),
        seed = JSON.parse(readFileSync(seedPath));
      const result = {
        ...bindOwnOperatorActor(parent, r, prep, seed, identity, groups.groups.sort()),
        observedAt: new Date().toISOString(),
        readerSha256: sha256(readFileSync(new URL(import.meta.url))),
        bindings: [seedPath, seedPath + '.preparation.json', parent.versionReceipt].map((path) => ({
          path,
          sha256: sha256(readFileSync(path)),
        })),
      };
      writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    if (parent.finishedAt) throw Error('PARENT_FINISHED_WITHOUT_REAL_OPERATOR');
    await pause(1000);
  }
  throw Error('REAL_OPERATOR_NOT_READY_IN_READ_BUDGET');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  collectOperatorActorBinding(...process.argv.slice(2))
    .then((r) => console.log(JSON.stringify({ gate: r.gate, prefix: r.prefix })))
    .catch(() => {
      process.stderr.write('OWN_OPERATOR_ACTOR_READ_NOT_VERIFIED\n');
      process.exitCode = 1;
    });
