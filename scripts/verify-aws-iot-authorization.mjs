#!/usr/bin/env node
/**
 * AUTH-04 真实 AWS IoT 权限验收：创建隔离 Thing/证书/Policy，调用 TestAuthorization
 * 验证最终合并权限的允许/拒绝矩阵，最后清理全部临时资源并输出无秘密值 JSON 回执。
 *
 * 运行：FDP_AWS_IOT_INTEGRATION=1 AWS_REGION=ap-southeast-1 \
 *   node --import tsx scripts/verify-aws-iot-authorization.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildDevicePolicy, DOWNLINK_TOPIC_TYPES, UPLINK_TOPIC_TYPES } from '../packages/aws-clients/src/index.ts';

const enabled = process.env.FDP_AWS_IOT_INTEGRATION === '1';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const receiptPath = resolve(
  process.env.FDP_AWS_IOT_RECEIPT ?? 'docs/audit/evidence/auth-04-aws-iot-authorization.json',
);
const profileArgs = process.env.AWS_PROFILE ? ['--profile', process.env.AWS_PROFILE] : [];

function aws(service, operation, args = []) {
  const stdout = execFileSync(
    'aws',
    [service, operation, '--region', region, ...profileArgs, ...args, '--output', 'json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function authorizationCases(accountId, ownThing, otherThing) {
  const resource = (type, thing, topicType) =>
    `arn:aws:iot:${region}:${accountId}:${type}/${topicType ? `bnx/device/${thing}/${topicType}` : thing}`;
  const cases = [
    { name: 'connect-own-client', actionType: 'CONNECT', resource: resource('client', ownThing), allowed: true },
    { name: 'connect-other-client', actionType: 'CONNECT', resource: resource('client', otherThing), allowed: false },
  ];
  for (const type of UPLINK_TOPIC_TYPES) {
    cases.push(
      {
        name: `publish-own-${type}`,
        actionType: 'PUBLISH',
        resource: resource('topic', ownThing, type),
        allowed: true,
      },
      {
        name: `publish-other-${type}`,
        actionType: 'PUBLISH',
        resource: resource('topic', otherThing, type),
        allowed: false,
      },
      {
        name: `subscribe-own-${type}`,
        actionType: 'SUBSCRIBE',
        resource: resource('topicfilter', ownThing, type),
        allowed: false,
      },
      {
        name: `receive-own-${type}`,
        actionType: 'RECEIVE',
        resource: resource('topic', ownThing, type),
        allowed: false,
      },
    );
  }
  for (const type of DOWNLINK_TOPIC_TYPES) {
    cases.push(
      {
        name: `publish-own-${type}`,
        actionType: 'PUBLISH',
        resource: resource('topic', ownThing, type),
        allowed: false,
      },
      {
        name: `subscribe-own-${type}`,
        actionType: 'SUBSCRIBE',
        resource: resource('topicfilter', ownThing, type),
        allowed: true,
      },
      {
        name: `subscribe-other-${type}`,
        actionType: 'SUBSCRIBE',
        resource: resource('topicfilter', otherThing, type),
        allowed: false,
      },
      {
        name: `receive-own-${type}`,
        actionType: 'RECEIVE',
        resource: resource('topic', ownThing, type),
        allowed: true,
      },
      {
        name: `receive-other-${type}`,
        actionType: 'RECEIVE',
        resource: resource('topic', otherThing, type),
        allowed: false,
      },
    );
  }
  cases.push(
    {
      name: 'publish-wildcard-topic',
      actionType: 'PUBLISH',
      resource: resource('topic', ownThing, '*'),
      allowed: false,
    },
    {
      name: 'subscribe-wildcard-filter',
      actionType: 'SUBSCRIBE',
      resource: resource('topicfilter', ownThing, '*'),
      allowed: false,
    },
  );
  return cases;
}

if (!enabled) {
  process.stderr.write('拒绝运行：必须显式设置 FDP_AWS_IOT_INTEGRATION=1，并使用隔离的开发 AWS 账号。\n');
  process.exitCode = 2;
} else if (!region) {
  process.stderr.write('拒绝运行：缺少 AWS_REGION/AWS_DEFAULT_REGION。\n');
  process.exitCode = 2;
} else if (!existsSync(resolve('node_modules/.bin/tsx'))) {
  process.stderr.write('拒绝运行：缺少工作区 tsx 依赖。\n');
  process.exitCode = 2;
} else {
  const identity = aws('sts', 'get-caller-identity');
  const accountId = identity.Account;
  const suffix = `${Date.now().toString(36)}-${process.pid}`.toLowerCase();
  const ownThing = `fdp-auth04-${suffix}`;
  const otherThing = `fdp-auth04-other-${suffix}`;
  const resources = [ownThing, otherThing].map((thingName) => ({
    thingName,
    ...buildDevicePolicy({ region, accountId, thingName }),
    certificateId: undefined,
    certificateArn: undefined,
    policyCreated: false,
    thingCreated: false,
  }));
  const cleanup = [];
  let receipt;
  const attemptCleanup = (name, fn) => {
    try {
      fn();
      cleanup.push({ name, status: 'PASS' });
    } catch (cleanupError) {
      void cleanupError;
      cleanup.push({ name, status: 'FAIL' });
    }
  };

  try {
    for (const resource of resources) {
      aws('iot', 'create-thing', ['--thing-name', resource.thingName]);
      resource.thingCreated = true;
      const certificate = aws('iot', 'create-keys-and-certificate', ['--set-as-active']);
      resource.certificateId = certificate.certificateId;
      resource.certificateArn = certificate.certificateArn;
      aws('iot', 'create-policy', [
        '--policy-name',
        resource.policyName,
        '--policy-document',
        JSON.stringify(resource.policyDocument),
      ]);
      resource.policyCreated = true;
      aws('iot', 'attach-policy', ['--policy-name', resource.policyName, '--target', resource.certificateArn]);
      aws('iot', 'attach-thing-principal', [
        '--thing-name',
        resource.thingName,
        '--principal',
        resource.certificateArn,
      ]);
    }

    const results = resources.flatMap((resource, index) => {
      const peer = resources[index === 0 ? 1 : 0];
      return authorizationCases(accountId, resource.thingName, peer.thingName).map((probe) => {
        const response = aws('iot', 'test-authorization', [
          '--principal',
          resource.certificateArn,
          '--client-id',
          resource.thingName,
          '--auth-infos',
          JSON.stringify([{ actionType: probe.actionType, resources: [probe.resource] }]),
        ]);
        const decision = response.authResults?.[0]?.authDecision ?? 'MISSING';
        const passed = probe.allowed ? decision === 'ALLOWED' : decision !== 'ALLOWED';
        return { principalThing: resource.thingName, ...probe, decision, passed };
      });
    });
    receipt = {
      schemaVersion: 1,
      task: 'AUTH-04',
      testedAt: new Date().toISOString(),
      region,
      accountId,
      resources: resources.map(({ thingName, certificateId, policyName, policyDocument }) => ({
        thingName,
        certificateId,
        policyName,
        policyDocument,
      })),
      summary: {
        total: results.length,
        passed: results.filter((result) => result.passed).length,
        failed: results.filter((result) => !result.passed).length,
      },
      results,
    };
  } finally {
    for (const resource of resources.reverse()) {
      if (resource.certificateArn && resource.policyCreated) {
        attemptCleanup(`detach-policy:${resource.policyName}`, () =>
          aws('iot', 'detach-policy', ['--policy-name', resource.policyName, '--target', resource.certificateArn]),
        );
      }
      if (resource.certificateArn && resource.thingCreated) {
        attemptCleanup(`detach-thing-principal:${resource.thingName}`, () =>
          aws('iot', 'detach-thing-principal', [
            '--thing-name',
            resource.thingName,
            '--principal',
            resource.certificateArn,
          ]),
        );
      }
      if (resource.certificateId) {
        attemptCleanup(`deactivate-certificate:${resource.certificateId}`, () =>
          aws('iot', 'update-certificate', ['--certificate-id', resource.certificateId, '--new-status', 'INACTIVE']),
        );
        attemptCleanup(`delete-certificate:${resource.certificateId}`, () =>
          aws('iot', 'delete-certificate', ['--certificate-id', resource.certificateId]),
        );
      }
      if (resource.policyCreated) {
        attemptCleanup(`delete-policy:${resource.policyName}`, () =>
          aws('iot', 'delete-policy', ['--policy-name', resource.policyName]),
        );
      }
      if (resource.thingCreated) {
        attemptCleanup(`delete-thing:${resource.thingName}`, () =>
          aws('iot', 'delete-thing', ['--thing-name', resource.thingName]),
        );
      }
    }
    if (receipt) {
      receipt.cleanup = {
        total: cleanup.length,
        passed: cleanup.filter((result) => result.status === 'PASS').length,
        failed: cleanup.filter((result) => result.status === 'FAIL').length,
        results: cleanup,
      };
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }
  }
  if (receipt.summary.failed > 0 || receipt.cleanup.failed > 0) {
    throw new Error(
      `AUTH-04 AWS IoT authorization/cleanup failed: probes=${receipt.summary.failed}, cleanup=${receipt.cleanup.failed}`,
    );
  }
  process.stdout.write(`AUTH-04 AWS IoT authorization PASS: ${receipt.summary.passed}/${receipt.summary.total}\n`);
  process.stdout.write(`receipt: ${receiptPath}\n`);
}
