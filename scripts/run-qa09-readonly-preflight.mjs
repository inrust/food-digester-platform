#!/usr/bin/env node
import { execFileSync, execFile } from 'node:child_process';
import { request } from 'node:https';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
export const TARGET = {
  accountId: '065986019555',
  region: 'ap-southeast-1',
  stackName: 'fdp-test-app',
  profile: 'esgiot-readonly',
};
export const ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export const GATES = [
  'check-aws-iot-data-path-evidence',
  'check-aws-data-processing-evidence',
  'check-aws-admin-cus-dev-evidence',
  'check-aws-admin-business-evidence',
  'check-aws-med-rbac-aud-dash-set-evidence',
  'check-admin-web-target-evidence',
  'check-admin-web-fe11-15-target-evidence',
  'check-admin-web-fe16-19-target-evidence',
];
export function guardIdentity(identity) {
  if (
    identity.Account !== TARGET.accountId ||
    !new RegExp(`^arn:aws:sts::${TARGET.accountId}:assumed-role/AWSReservedSSO_FDP-ReadOnlyOps_[a-zA-Z0-9]+/`).test(
      identity.Arn ?? '',
    )
  )
    throw Error('WRONG_ACCOUNT_OR_READONLY_ROLE');
}
export function guardStack(stack) {
  if (
    stack.StackName !== TARGET.stackName ||
    !stack.StackId?.startsWith(
      `arn:aws:cloudformation:${TARGET.region}:${TARGET.accountId}:stack/${TARGET.stackName}/`,
    ) ||
    !stack.Tags?.some((t) => t.Key === 'fdp:env' && t.Value === 'test') ||
    !stack.Tags?.some((t) => t.Key === 'fdp:project' && t.Value === 'food-digester-platform')
  )
    throw Error('UNVERIFIED_TEST_STACK');
}
export function errorCategory(error) {
  const message = String(error.stderr ?? error.message ?? error);
  for (const category of [
    'AccessDeniedException',
    'AccessDenied',
    'ExpiredToken',
    'UnauthorizedException',
    'ResourceNotFoundException',
    'ValidationError',
    'SSO_INVALID_OR_EXPIRED',
  ])
    if (message.includes(category)) return category;
  if (/SSO|sso|refresh.*token|Token.*expired/.test(message)) return 'SSO_INVALID_OR_EXPIRED';
  if (/ENOTFOUND|Could not connect|timed out|ETIMEDOUT/.test(message)) return 'NETWORK_UNAVAILABLE';
  return 'READ_FAILED';
}
async function readAws(service, operation, args = [], query) {
  const parameters = [
    service,
    operation,
    ...args,
    '--profile',
    TARGET.profile,
    '--region',
    TARGET.region,
    '--output',
    'json',
    '--no-cli-pager',
  ];
  if (query) parameters.push('--query', query);
  try {
    const { stdout } = await execute('aws', parameters, {
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' },
    });
    return { status: 'OBSERVED', data: JSON.parse(stdout) };
  } catch (error) {
    return { status: 'UNVERIFIED', error: errorCategory(error) };
  }
}
async function bounded(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
export function assess(observations, sourceCommit) {
  const blockers = [
    'Current database migration state and two Customer scopes are NOT VERIFIED: no direct read-only database channel was used.',
    'Ten QA09-controlled devices with usable private credentials, tenant ownership and cleanup capability are NOT VERIFIED; IoT inventory counts cannot prove this.',
    'Test-write/cleanup permissions, budget, artifact destination and fault-injection recovery scope require a concrete authorization package.',
    'Device-auth/Command/OTA/FE01-05/security/load target receipt schemas and collectors require gap review before full acceptance.',
  ];
  const byId = Object.fromEntries(observations.map((o) => [o.id, o]));
  for (const id of [
    'stack',
    'resources',
    'rds',
    'cognito-pool',
    'cognito-client',
    'cognito-users',
    ...ROLES.map((r) => `members-${r}`),
  ])
    if (byId[id]?.status !== 'OBSERVED') blockers.push(`${id}: ${byId[id]?.error ?? 'NOT_OBSERVED'}`);
  if (byId.stack?.data?.Status && !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(byId.stack.data.Status))
    blockers.push(`Stack is ${byId.stack.data.Status}`);
  for (const role of ROLES) {
    const members = byId[`members-${role}`];
    if (members?.status === 'OBSERVED' && !members.data.some((u) => u.enabled === true && u.status === 'CONFIRMED'))
      blockers.push(`No enabled CONFIRMED Cognito identity in ${role}`);
  }
  const builds = byId['amplify-jobs'];
  const latest = builds?.data?.[0];
  if (!latest || latest.status !== 'SUCCEED' || latest.commitId !== sourceCommit)
    blockers.push('Latest Amplify deployment does not prove the exact acceptance source commit.');
  const workflow = byId['github-deploy-runs'];
  const successful = workflow?.data?.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (!successful || successful.headSha !== sourceCommit)
    blockers.push('Successful backend deploy workflow is absent or differs from acceptance source commit.');
  const comparison = byId['migration-source-comparison'];
  if (comparison?.data?.changedOrMissing?.length)
    blockers.push(
      `${comparison.data.changedOrMissing.length} migration SQL files differ from the latest successful runner source; live application is NOT VERIFIED.`,
    );
  if (byId['iot-things-count']?.data?.count < 10 || byId['iot-certificates-count']?.data?.active < 10)
    blockers.push('IoT inventory has fewer than ten Things or ACTIVE certificates.');
  if (byId['queue-Quarantine']?.data?.ApproximateNumberOfMessages !== '0')
    blockers.push(
      'Quarantine baseline is nonempty or unverified; preserve existing messages and define prefix-scoped cleanup.',
    );
  for (const o of observations.filter((o) => o.status === 'UNVERIFIED')) blockers.push(`${o.id}: ${o.error}`);
  blockers.push(
    'Backend CodeSha256 and deployed template assets are inventoried; source-to-artifact byte provenance is not yet fully verified.',
  );
  for (const o of observations.filter((o) => o.id.startsWith('lambda-')))
    if (o.status !== 'OBSERVED' || o.data?.State !== 'Active' || o.data?.LastUpdateStatus !== 'Successful')
      blockers.push(`${o.id}: unhealthy or UNVERIFIED`);
  for (const o of observations.filter((o) => o.id.startsWith('gate-')))
    if (o.exitCode !== 0) blockers.push(`${o.id}: ${o.status}`);
  return { readinessGate: 'BLOCKED', awsAcceptanceGate: 'NOT RUN / NO RECEIPT', blockers };
}
async function readGithub(id, args) {
  try {
    const { stdout } = await execute(existsSync('/opt/homebrew/bin/gh') ? '/opt/homebrew/bin/gh' : 'gh', args, {
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { id, status: 'OBSERVED', data: JSON.parse(stdout) };
  } catch (error) {
    return {
      id,
      status: 'UNVERIFIED',
      error: /404|Not Found/.test(String(error.stderr))
        ? 'GITHUB_404_VISIBILITY_UNVERIFIED'
        : error.code === 'ENOENT'
          ? 'GITHUB_CLI_UNAVAILABLE'
          : 'GITHUB_READ_FAILED',
    };
  }
}
async function publicRead([id, url, method, origin]) {
  return new Promise((done) => {
    const req = request(
      url,
      {
        method,
        timeout: 15000,
        headers: origin
          ? {
              Origin: origin,
              'Access-Control-Request-Method': 'GET',
              'Access-Control-Request-Headers': 'authorization',
            }
          : {},
      },
      (res) => {
        res.resume();
        done({
          id,
          status: 'OBSERVED',
          data: {
            httpStatus: res.statusCode,
            allowOrigin: res.headers['access-control-allow-origin'] ?? null,
            requestId: res.headers['x-amzn-requestid'] ?? res.headers['x-request-id'] ?? null,
          },
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (error) => done({ id, status: 'TRANSPORT_REJECTED', error: error.code ?? 'UNKNOWN' }));
    req.end();
  });
}
export async function main(args) {
  if (args.length !== 1) throw Error('USAGE: node scripts/run-qa09-readonly-preflight.mjs <preflight.json>');
  const output = resolve(args[0]),
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const observations = [];
  const identity = await readAws('sts', 'get-caller-identity');
  if (identity.status !== 'OBSERVED') throw Error(`IDENTITY_NOT_VERIFIED:${identity.error}`);
  guardIdentity(identity.data);
  observations.push({
    id: 'identity',
    status: 'OBSERVED',
    data: { accountId: identity.data.Account, role: identity.data.Arn.split('/')[1] },
  });
  const stack = await readAws(
    'cloudformation',
    'describe-stacks',
    ['--stack-name', TARGET.stackName],
    'Stacks[0].{StackName:StackName,StackId:StackId,Status:StackStatus,Updated:LastUpdatedTime,Tags:Tags,Outputs:Outputs}',
  );
  if (stack.status !== 'OBSERVED') throw Error(`STACK_NOT_VERIFIED:${stack.error}`);
  guardStack(stack.data);
  observations.push({ id: 'stack', ...stack });
  const outputs = Object.fromEntries(stack.data.Outputs.map((o) => [o.OutputKey, o.OutputValue]));
  const pool = outputs.UserPoolId;
  if (!pool?.startsWith(`${TARGET.region}_`) || !outputs.UserPoolClientId) throw Error('INVALID_COGNITO_LOCATOR');
  for (const name of ['Ingress', 'Archive', 'Replay', 'Quarantine', 'RuleError'])
    if (
      !outputs[`${name}QueueUrl`]?.startsWith(
        `https://sqs.${TARGET.region}.amazonaws.com/${TARGET.accountId}/fdp-test-`,
      )
    )
      throw Error('INVALID_TEST_QUEUE_LOCATOR');
  for (const name of ['Raw', 'Media', 'Ota', 'Export', 'MigrationSource'])
    if (
      !outputs[`${name}BucketName`]?.startsWith('fdp-test-') ||
      !outputs[`${name}BucketName`].includes(TARGET.accountId)
    )
      throw Error('INVALID_TEST_BUCKET_LOCATOR');
  const probes = [
    [
      'budget',
      'budgets',
      'describe-budget',
      ['--account-id', TARGET.accountId, '--budget-name', 'BioNexa-FDP-Test-Budget'],
      'Budget.{name:BudgetName,limit:BudgetLimit,unit:TimeUnit,type:BudgetType,filters:CostFilters,spend:CalculatedSpend}',
    ],
    [
      'resources',
      'cloudformation',
      'list-stack-resources',
      ['--stack-name', TARGET.stackName],
      'StackResourceSummaries[].{type:ResourceType,id:PhysicalResourceId,status:ResourceStatus}',
    ],
    [
      'rds',
      'rds',
      'describe-db-instances',
      ['--db-instance-identifier', 'fdp-test-db'],
      'DBInstances[].{identifier:DBInstanceIdentifier,status:DBInstanceStatus,engine:Engine,version:EngineVersion,encrypted:StorageEncrypted,public:PubliclyAccessible,multiAZ:MultiAZ,backupRetentionDays:BackupRetentionPeriod,endpoint:Endpoint.Address}',
    ],
    [
      'cognito-pool',
      'cognito-idp',
      'describe-user-pool',
      ['--user-pool-id', pool],
      'UserPool.{id:Id,name:Name,estimatedUsers:EstimatedNumberOfUsers,mfa:MfaConfiguration,passwordPolicy:Policies.PasswordPolicy}',
    ],
    [
      'cognito-client',
      'cognito-idp',
      'describe-user-pool-client',
      ['--user-pool-id', pool, '--client-id', outputs.UserPoolClientId],
      'UserPoolClient.{id:ClientId,authFlows:ExplicitAuthFlows,preventUserExistenceErrors:PreventUserExistenceErrors}',
    ],
    [
      'cognito-groups',
      'cognito-idp',
      'list-groups',
      ['--user-pool-id', pool],
      'Groups[].{name:GroupName,precedence:Precedence}',
    ],
    [
      'cognito-users',
      'cognito-idp',
      'list-users',
      ['--user-pool-id', pool],
      'Users[].{status:UserStatus,enabled:Enabled}',
    ],
    ...ROLES.map((role) => [
      `members-${role}`,
      'cognito-idp',
      'list-users-in-group',
      ['--user-pool-id', pool, '--group-name', role],
      'Users[].{status:UserStatus,enabled:Enabled}',
    ]),
    ['iot-endpoint', 'iot', 'describe-endpoint', ['--endpoint-type', 'iot:Data-ATS'], '{endpoint:endpointAddress}'],
    ['iot-things-count', 'iot', 'list-things', [], '{count:length(things)}'],
    [
      'iot-certificates-count',
      'iot',
      'list-certificates',
      [],
      "{count:length(certificates),active:length(certificates[?status=='ACTIVE'])}",
    ],
    [
      'migration-build-ids',
      'codebuild',
      'list-builds-for-project',
      ['--project-name', outputs.MigrationRunnerProjectName, '--sort-order', 'DESCENDING'],
      'ids[:5]',
    ],
    [
      'bootstrap-build-ids',
      'codebuild',
      'list-builds-for-project',
      ['--project-name', outputs.AdminBootstrapRunnerProjectName, '--sort-order', 'DESCENDING'],
      'ids[:5]',
    ],
    [
      'amplify-jobs',
      'amplify',
      'list-jobs',
      [
        '--app-id',
        outputs.AdminWebAmplifyAppId,
        '--branch-name',
        outputs.AdminWebAmplifyBranchName,
        '--max-results',
        '5',
      ],
      'jobSummaries[].{jobId:jobId,commitId:commitId,status:status,startTime:startTime,endTime:endTime}',
    ],
    ...['Ingress', 'Archive', 'Replay', 'Quarantine', 'RuleError'].map((name) => [
      `queue-${name}`,
      'sqs',
      'get-queue-attributes',
      [
        '--queue-url',
        outputs[`${name}QueueUrl`],
        '--attribute-names',
        'QueueArn',
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
        'RedrivePolicy',
      ],
      'Attributes',
    ]),
    ...['Raw', 'Media', 'Ota', 'Export', 'MigrationSource'].map((name) => [
      `bucket-${name}`,
      's3api',
      'get-bucket-versioning',
      ['--bucket', outputs[`${name}BucketName`]],
      '{versioning:Status}',
    ]),
    ...['device-api.bio-nexa.com', 'api.bio-nexa.com', 'onboard-api.bio-nexa.com'].map((domain) => [
      `domain-${domain}`,
      'apigateway',
      'get-domain-name',
      ['--domain-name', domain],
      '{domain:domainName,status:domainNameStatus,certificate:regionalCertificateArn,mtls:mutualTlsAuthentication}',
    ]),
  ];
  observations.push(
    ...(await bounded(probes, async ([id, service, operation, parameters, query]) => ({
      id,
      ...(await readAws(service, operation, parameters, query)),
    }))),
  );
  const template = await readAws('cloudformation', 'get-template', ['--stack-name', TARGET.stackName], 'TemplateBody');
  if (template.status === 'OBSERVED') {
    const body = typeof template.data === 'string' ? JSON.parse(template.data) : template.data;
    observations.push({
      id: 'deployed-template-assets',
      status: 'OBSERVED',
      data: Object.entries(body.Resources ?? {})
        .filter(([, r]) => r.Type === 'AWS::Lambda::Function')
        .map(([logicalId, r]) => ({ logicalId, code: r.Properties.Code })),
    });
  } else observations.push({ id: 'deployed-template-assets', ...template });
  const resources = observations.find((o) => o.id === 'resources');
  if (resources.status === 'OBSERVED')
    observations.push(
      ...(await bounded(
        resources.data.filter((r) => r.type === 'AWS::Lambda::Function' && r.id.startsWith('fdp-test-')),
        async (r) => ({
          id: `lambda-${r.id}`,
          ...(await readAws(
            'lambda',
            'get-function-configuration',
            ['--function-name', r.id],
            '{name:FunctionName,CodeSha256:CodeSha256,LastModified:LastModified,Runtime:Runtime,State:State,LastUpdateStatus:LastUpdateStatus,RevisionId:RevisionId}',
          )),
        }),
      )),
    );
  for (const kind of ['migration', 'bootstrap']) {
    const ids = observations.find((o) => o.id === `${kind}-build-ids`);
    if (ids.status === 'OBSERVED' && ids.data.length)
      observations.push({
        id: `${kind}-builds`,
        ...(await readAws(
          'codebuild',
          'batch-get-builds',
          ['--ids', ...ids.data],
          "{builds:builds[].{id:id,status:buildStatus,start:startTime,end:endTime,sourceVersion:sourceVersion,resolvedSourceVersion:resolvedSourceVersion,sourceCommit:environment.environmentVariables[?name=='FDP_EXPECTED_SOURCE_COMMIT'].value},missing:buildsNotFound}",
        )),
      });
  }
  observations.push(
    ...(await Promise.all([
      readGithub('github-main', ['api', 'repos/inrust/food-digester-platform/commits/main', '--jq', '{sha:.sha}']),
      readGithub('github-deploy-runs', [
        'run',
        'list',
        '--repo',
        'inrust/food-digester-platform',
        '--workflow',
        'deploy-test.yml',
        '--limit',
        '5',
        '--json',
        'databaseId,headSha,status,conclusion,createdAt,updatedAt,url,event',
      ]),
    ])),
  );
  observations.push(
    ...(await Promise.all(
      [
        ['http-admin-login', 'https://admin.bio-nexa.com/login', 'GET'],
        ['http-admin-no-token', 'https://api.bio-nexa.com/api/v1/admin/devices', 'GET'],
        ['http-device-no-cert', 'https://device-api.bio-nexa.com/api/v1/device/licenses', 'GET'],
        ['http-cors-allowed', 'https://api.bio-nexa.com/api/v1/admin/devices', 'OPTIONS', 'https://admin.bio-nexa.com'],
        ['http-cors-rejected', 'https://api.bio-nexa.com/api/v1/admin/devices', 'OPTIONS', 'https://qa09.invalid'],
      ].map(publicRead),
    )),
  );
  for (const gate of GATES) {
    try {
      execFileSync(process.execPath, [`scripts/${gate}.mjs`], { encoding: 'utf8', stdio: 'pipe' });
      observations.push({ id: `gate-${gate}`, status: 'PASS', exitCode: 0 });
    } catch (error) {
      const message = String(error.stdout ?? '') + String(error.stderr ?? '');
      observations.push({
        id: `gate-${gate}`,
        status: /NOT RUN|NO RECEIPT|缺少.*回执/.test(message) ? 'NOT RUN / NO RECEIPT' : 'FAIL',
        exitCode: error.status ?? 1,
      });
    }
  }
  const migrationFiles = readdirSync('packages/database/prisma/migrations').filter((f) => f !== 'migration_lock.toml');
  const lastMigration = observations
    .find((o) => o.id === 'migration-builds')
    ?.data?.builds?.find((b) => b.status === 'SUCCEEDED');
  const historicalCommit = lastMigration?.sourceCommit?.[0];
  if (/^[a-f0-9]{40}$/.test(historicalCommit ?? '')) {
    const changedOrMissing = migrationFiles.filter((f) => {
      const path = `packages/database/prisma/migrations/${f}/migration.sql`;
      try {
        return !execFileSync('git', ['show', `${historicalCommit}:${path}`], {
          stdio: ['ignore', 'pipe', 'ignore'],
        }).equals(readFileSync(path));
      } catch {
        return true;
      }
    });
    observations.push({
      id: 'migration-source-comparison',
      status: 'OBSERVED',
      data: {
        historicalBuildId: lastMigration.id,
        historicalCommit,
        currentMigrationFiles: migrationFiles.length,
        changedOrMissing,
        currentDatabaseState: 'NOT VERIFIED',
      },
    });
  }
  const hashes = Object.fromEntries(
    [
      'infra/environments/esgiot-test.json',
      'package.json',
      'scripts/run-qa09-readonly-preflight.mjs',
      'scripts/qa09-readonly-preflight.test.mjs',
      ...migrationFiles.map((f) => `packages/database/prisma/migrations/${f}/migration.sql`),
    ].map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
  );
  const receipt = {
    schemaVersion: '1.0',
    task: 'QA-09',
    phase: 'READ_ONLY_PREFLIGHT',
    executedAt: new Date().toISOString(),
    sourceCommit,
    target: TARGET,
    execution: {
      mode: 'REAL_AWS_READ_ONLY',
      secretValuesRead: false,
      cloudMutations: false,
      businessDataWrites: false,
      faultInjection: false,
      deploymentOrMigrationStarted: false,
      remotePush: false,
    },
    sourceHashes: hashes,
    localMigrationInventory: migrationFiles.sort(),
    observations,
    ...assess(observations, sourceCommit),
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        readinessGate: receipt.readinessGate,
        awsAcceptanceGate: receipt.awsAcceptanceGate,
        observations: observations.length,
        blockers: receipt.blockers,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
