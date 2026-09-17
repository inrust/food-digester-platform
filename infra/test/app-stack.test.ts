/**
 * IAC-01 模板断言测试（验收基准的机器证明）：
 * 1. 资源名支持环境前缀；
 * 2. 无公网 S3/RDS；
 * 3. 角色权限没有 `*:*`；
 * 4. 三类 API 认证入口分离（Onboarding=Token、Device=mTLS、Admin/Customer=Cognito、Internal=IAM）；
 * 5. 数据库凭据经 Secrets Manager；S3 阻断公网并启用 Versioning；队列 KMS 加密且主队列有 DLQ；
 * 6. 8 个 IoT Rule 按上行 Topic 路由到 Ingress SQS，Error Action 写独立错误队列；
 * 7. 应用配置经 Lambda 环境变量与 CfnOutput 输出。
 */
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { assert, describe, test } from 'vitest';
import type { InfraConfig } from '../src/config.js';
import { AppDependenciesStack } from '../src/stacks/app-dependencies-stack.js';
import {
  broadAllowViolations,
  collectPolicyStatements,
  wildcardKmsPrincipalViolations,
} from '../src/template-security.js';
import { UPLINK_TOPIC_TYPES } from '../src/topics.js';

function synthTemplate(config: InfraConfig = { envName: 'test', allowInsecureDeviceEndpointForLocal: true }): Template {
  const app = new App();
  const stack = new AppDependenciesStack(app, 'TestStack', { config });
  return Template.fromStack(stack);
}

function resourcesOfType(template: Template, type: string): Record<string, any> {
  return template.findResources(type);
}

/** 收集模板中全部 IAM Policy 声明（独立 Policy、ManagedPolicy、Role 内联 Policies）。 */
// ---------- 资源命名与环境前缀 ----------

describe('资源命名（环境前缀）', () => {
  const template = synthTemplate();

  test('Stack 物理名带环境前缀', () => {
    const app = new App();
    const stack = new AppDependenciesStack(app, 'Named', {
      config: {
        envName: 'staging',
        deviceApiDomain: {
          domainName: 'device-api.example.com',
          certificateArn: 'arn:aws:acm:ap-southeast-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
          truststoreKey: 'truststore/ca-bundle.pem',
        },
      },
    });
    assert.equal(stack.stackName, 'fdp-staging-app');
  }, 15_000);

  test('SQS 队列名带环境前缀', () => {
    for (const suffix of [
      'ingress',
      'ingress-dlq',
      'archive',
      'archive-dlq',
      'replay',
      'replay-dlq',
      'quarantine',
      'iot-rule-error',
    ]) {
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: `fdp-test-${suffix}` });
    }
  });

  test('S3 Bucket 名带环境前缀（账号 ID 后缀保证全局唯一）', () => {
    const names = Object.values(resourcesOfType(template, 'AWS::S3::Bucket')).map((b) =>
      JSON.stringify(b.Properties.BucketName),
    );
    assert.equal(names.length, 5);
    for (const suffix of ['raw', 'ota', 'media', 'export', 'mtls-truststore']) {
      assert.isTrue(
        names.some((n) => n.includes(`fdp-test-${suffix}`) && n.includes('AWS::AccountId')),
        `缺少 Bucket fdp-test-${suffix}-<account>`,
      );
    }
  });

  test('IoT Rule / RDS / Lambda / Cognito 命名带环境前缀', () => {
    for (const type of UPLINK_TOPIC_TYPES) {
      template.hasResourceProperties('AWS::IoT::TopicRule', { RuleName: `fdp_test_iot_${type}` });
    }
    template.hasResourceProperties('AWS::RDS::DBInstance', { DBInstanceIdentifier: 'fdp-test-db' });
    for (const fn of [
      'ingestion',
      'archive',
      'outbox-publisher',
      'notification-publisher',
      'summary',
      'replay-trigger-publisher',
      'replay',
      'cert-package-sweeper',
      'onboarding-deadline',
      'retirement-timeout',
      'activity-export',
      'business-notifier',
      'esg-export',
      'onboarding-api-handler',
      'onboarding-provisioning',
      'device-api-handler',
      'api',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: `fdp-test-${fn}` });
    }
    template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolName: 'fdp-test-admin' });
  });
});

// ---------- 验收：无公网 S3/RDS ----------

describe('验收：无公网 S3/RDS', () => {
  const template = synthTemplate();

  test('全部 S3 Bucket 阻断公网访问', () => {
    const buckets = resourcesOfType(template, 'AWS::S3::Bucket');
    assert.equal(Object.keys(buckets).length, 5);
    for (const bucket of Object.values(buckets)) {
      assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  test('全部 S3 Bucket 强制 TLS（拒绝 aws:SecureTransport=false）', () => {
    const policies = Object.values(resourcesOfType(template, 'AWS::S3::BucketPolicy'));
    assert.equal(policies.length, 5);
    for (const policy of policies) {
      const deny = (policy.Properties.PolicyDocument.Statement as any[]).find(
        (s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
      );
      assert.isDefined(deny, 'Bucket Policy 缺少 TLS 强制拒绝声明');
    }
  });

  test('全部 S3 Bucket 启用 Versioning 与 KMS 静态加密', () => {
    for (const bucket of Object.values(resourcesOfType(template, 'AWS::S3::Bucket'))) {
      assert.equal(bucket.Properties.VersioningConfiguration?.Status, 'Enabled');
      const sse = bucket.Properties.BucketEncryption?.ServerSideEncryptionConfiguration?.[0];
      assert.equal(sse?.ServerSideEncryptionByDefault?.SSEAlgorithm, 'aws:kms');
    }
  });

  test('活动导出 Bucket 对 activity-exports 前缀启用 1 天自动清理', () => {
    const exportBucket = Object.values(resourcesOfType(template, 'AWS::S3::Bucket')).find((bucket) =>
      JSON.stringify(bucket.Properties.BucketName).includes('fdp-test-export'),
    );
    assert.isDefined(exportBucket);
    assert.deepInclude(exportBucket.Properties.LifecycleConfiguration.Rules[0], {
      Id: 'ExpireActivityExports',
      Prefix: 'activity-exports/',
      Status: 'Enabled',
      ExpirationInDays: 1,
      NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    });
  });

  test('RDS 非公网可达且存储加密', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      Engine: 'postgres',
      MultiAZ: false,
    });
  });
});

// ---------- 验收：角色权限没有 *:* ----------

describe('验收：IAM 最小权限', () => {
  const template = synthTemplate();

  test('IAM/ManagedPolicy/Role/KeyPolicy 不存在 service:* + 通配 Resource', () => {
    assert.isAbove(collectPolicyStatements(template.toJSON()).length, 0);
    assert.deepEqual(broadAllowViolations(template.toJSON()), []);
    assert.deepEqual(wildcardKmsPrincipalViolations(template.toJSON()), []);
  });

  test('证书包 KMS Key 数据面仅允许 Onboarding/Device API、Provisioning Worker 与恢复 Lambda role', () => {
    const keys = Object.values(resourcesOfType(template, 'AWS::KMS::Key'));
    const certKey = keys.find((key) => key.Properties.Description.includes('DEC-003'));
    assert.isDefined(certKey);
    const statements = certKey.Properties.KeyPolicy.Statement as any[];
    const cryptoOperations = ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:ReEncryptFrom'];
    const grantsCrypto = (action: string): boolean =>
      cryptoOperations.some((operation) =>
        action.endsWith('*') ? operation.startsWith(action.slice(0, -1)) : operation === action,
      );
    const dataPlane = statements.filter((statement) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some(grantsCrypto),
    );
    assert.equal(dataPlane.length, 1, '证书包 Key 只能有一条数据面授权声明');
    assert.include(
      JSON.stringify(dataPlane[0].Condition?.ArnEquals?.['aws:PrincipalArn']),
      'fdp-test-onboarding-api-role',
    );
    assert.include(JSON.stringify(dataPlane[0].Condition?.ArnEquals?.['aws:PrincipalArn']), 'fdp-test-device-api-role');
    assert.include(
      JSON.stringify(dataPlane[0].Condition?.ArnEquals?.['aws:PrincipalArn']),
      'fdp-test-onboarding-provisioning-role',
    );
    assert.include(
      JSON.stringify(dataPlane[0].Condition?.ArnEquals?.['aws:PrincipalArn']),
      'fdp-test-cert-package-sweeper-role',
    );
    const admin = statements.find((statement) => statement.Sid === 'KeyAdministrationOnly');
    assert.isDefined(admin);
    const adminActions = Array.isArray(admin.Action) ? admin.Action : [admin.Action];
    assert.isFalse(adminActions.some(grantsCrypto));
  });

  test('IoT Rule 角色仅允许向 Ingress 与 Rule Error 队列 SendMessage', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    const ruleStatements = statements.filter((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('sqs:SendMessage'),
    );
    assert.isAbove(ruleStatements.length, 0);
    for (const s of ruleStatements) {
      const sqsActions = (Array.isArray(s.Action) ? s.Action : [s.Action])
        .filter((a: string) => a.startsWith('sqs:'))
        .sort();
      // CDK grantSendMessages 附带队列元数据读取动作；仍为只读元数据 + 发送，无删除/接收权限
      assert.deepEqual(sqsActions, ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
    }
  });

  test('Command/OTA/Notification 三个独立 Publisher 各自收敛到单一 Topic 模式', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    for (const [sid, type] of [
      ['DeviceCommandPublish', 'cmd'],
      ['DeviceOtaPublish', 'ota'],
      ['DeviceNotificationPublish', 'notification'],
    ]) {
      const publish = statements.find((candidate) => candidate.Sid === sid);
      assert.isDefined(publish);
      assert.deepEqual(publish.Action, 'iot:Publish');
      assert.include(JSON.stringify(publish.Resource), `topic/bnx/device/*/${type}`);
      assert.notInclude(JSON.stringify(publish.Resource), 'topic/bnx/device/*/*');
    }
  });

  test('独立 Notification Publisher 仅可发现 IoT Endpoint 并发布设备 notification Topic', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    const discovery = statements.find((candidate) => candidate.Sid === 'IotDataEndpointDiscovery');
    assert.isDefined(discovery);
    assert.deepEqual(discovery.Action, 'iot:DescribeEndpoint');
    const publish = statements.find((candidate) => candidate.Sid === 'DeviceNotificationPublish');
    assert.isDefined(publish);
    assert.deepEqual(publish.Action, 'iot:Publish');
    assert.include(JSON.stringify(publish.Resource), 'topic/bnx/device/*/notification');
    assert.notInclude(JSON.stringify(publish.Resource), 'topic/bnx/device/*/*');
  });

  test('Archive 与 Notification Publisher 使用独立生产函数和环境依赖', () => {
    const functions = Object.values(resourcesOfType(template, 'AWS::Lambda::Function'));
    const archivePublisher = functions.find((fn) => fn.Properties.FunctionName === 'fdp-test-outbox-publisher');
    const notificationPublisher = functions.find(
      (fn) => fn.Properties.FunctionName === 'fdp-test-notification-publisher',
    );
    assert.isDefined(archivePublisher);
    assert.isDefined(notificationPublisher);
    assert.property(archivePublisher.Properties.Environment.Variables, 'ARCHIVE_QUEUE_URL');
    assert.notProperty(notificationPublisher.Properties.Environment.Variables, 'ARCHIVE_QUEUE_URL');
    assert.notEqual(archivePublisher.Properties.Code.S3Key, notificationPublisher.Properties.Code.S3Key);
  });

  test('Ingestion 与 deadline 仅可撤销当前账号/区域的 IoT certificate 资源', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    for (const sid of ['OnboardingHeartbeatCertificateRevoke', 'OnboardingDeadlineCertificateRevoke']) {
      const statement = statements.find((candidate) => candidate.Sid === sid);
      assert.isDefined(statement, `缺少 ${sid}`);
      assert.deepEqual(statement.Action, 'iot:UpdateCertificate');
      const resource = JSON.stringify(statement.Resource);
      assert.include(resource, ':cert/*');
      assert.notEqual(statement.Resource, '*');
    }
  });

  test('退役三条执行路径仅可停用当前账号/区域的 IoT certificate 资源', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    for (const sid of [
      'DeviceRetirementCertificateDeactivate',
      'AdminRetirementCertificateDeactivate',
      'RetirementTimeoutCertificateDeactivate',
    ]) {
      const statement = statements.find((candidate) => candidate.Sid === sid);
      assert.isDefined(statement, `缺少 ${sid}`);
      assert.deepEqual(statement.Action, 'iot:UpdateCertificate');
      assert.include(JSON.stringify(statement.Resource), ':cert/*');
      assert.notEqual(statement.Resource, '*');
    }
  });

  test('20 个 Lambda 使用各自独立执行角色', () => {
    const fns = Object.values(resourcesOfType(template, 'AWS::Lambda::Function')).filter((f) =>
      String(f.Properties.FunctionName ?? '').startsWith('fdp-test-'),
    );
    assert.equal(fns.length, 20);
    const roles = new Set(fns.map((f) => JSON.stringify(f.Properties.Role)));
    assert.equal(roles.size, 20);
  });

  test('P0 生产组合根与既有 API/sweeper 使用真实资产包而非内联 501 占位代码', () => {
    const fns = Object.values(resourcesOfType(template, 'AWS::Lambda::Function'));
    for (const name of [
      'fdp-test-ingestion',
      'fdp-test-outbox-publisher',
      'fdp-test-notification-publisher',
      'fdp-test-archive',
      'fdp-test-summary',
      'fdp-test-replay-trigger-publisher',
      'fdp-test-replay',
      'fdp-test-onboarding-deadline',
      'fdp-test-retirement-timeout',
      'fdp-test-activity-export',
      'fdp-test-business-notifier',
      'fdp-test-esg-export',
      'fdp-test-command-publisher',
      'fdp-test-command-timeout',
      'fdp-test-ota-dispatcher',
      'fdp-test-onboarding-api-handler',
      'fdp-test-onboarding-provisioning',
      'fdp-test-device-api-handler',
      'fdp-test-api',
      'fdp-test-cert-package-sweeper',
    ]) {
      const fn = fns.find((candidate) => candidate.Properties.FunctionName === name);
      assert.isDefined(fn);
      assert.isDefined(fn.Properties.Code.S3Bucket, `${name} 必须引用 CDK asset`);
      assert.isUndefined(fn.Properties.Code.ZipFile, `${name} 禁止回退到内联占位实现`);
    }
  });
});

// ---------- 验收：三类 API 认证入口分离 ----------

describe('验收：三类 API 认证入口分离', () => {
  const template = synthTemplate();

  function apiNameByLogicalId(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [logicalId, api] of Object.entries(resourcesOfType(template, 'AWS::ApiGateway::RestApi'))) {
      map.set(logicalId, api.Properties.Name);
    }
    return map;
  }

  function authTypesByApi(): Map<string, Set<string>> {
    const names = apiNameByLogicalId();
    const result = new Map<string, Set<string>>();
    for (const method of Object.values(resourcesOfType(template, 'AWS::ApiGateway::Method'))) {
      const apiLogicalId = method.Properties.RestApiId?.Ref as string;
      const apiName = names.get(apiLogicalId);
      if (!apiName) continue;
      if (!result.has(apiName)) result.set(apiName, new Set());
      result.get(apiName)?.add(method.Properties.AuthorizationType);
    }
    return result;
  }

  test('存在三个独立 RestApi：onboarding / device / admin', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 3);
    const names = new Set(apiNameByLogicalId().values());
    assert.deepEqual(names, new Set(['fdp-test-onboarding-api', 'fdp-test-device-api', 'fdp-test-admin-api']));
  });

  test('Onboarding/Device 入口方法级为 NONE（Token/mTLS 由独立机制承载），Admin 入口为 Cognito/IAM', () => {
    const byApi = authTypesByApi();
    assert.deepEqual([...(byApi.get('fdp-test-onboarding-api') ?? [])], ['NONE']);
    assert.deepEqual([...(byApi.get('fdp-test-device-api') ?? [])], ['NONE']);
    const admin = byApi.get('fdp-test-admin-api') ?? new Set();
    assert.isTrue(admin.has('COGNITO_USER_POOLS'), 'Admin/Customer 必须 Cognito JWT');
    assert.isTrue(admin.has('AWS_IAM'), 'Internal 必须 IAM');
    assert.isFalse(admin.has('NONE'), 'Admin 入口不允许未认证方法');
  });

  test('Onboarding Token 入口使用独立生产 Lambda，不经过管理 API Lambda', () => {
    const names = apiNameByLogicalId();
    const methods = Object.values(resourcesOfType(template, 'AWS::ApiGateway::Method')).filter(
      (method) => names.get(method.Properties.RestApiId?.Ref as string) === 'fdp-test-onboarding-api',
    );
    assert.isAbove(methods.length, 0);
    for (const method of methods) {
      const integration = JSON.stringify(method.Properties.Integration);
      assert.include(integration, 'OnboardingApiFn');
      assert.notInclude(integration, '"ApiFn');
    }
  });

  test('Device mTLS 入口使用独立生产 Lambda，不经过管理 API Lambda', () => {
    const names = apiNameByLogicalId();
    const methods = Object.values(resourcesOfType(template, 'AWS::ApiGateway::Method')).filter(
      (method) => names.get(method.Properties.RestApiId?.Ref as string) === 'fdp-test-device-api',
    );
    assert.isAbove(methods.length, 0);
    for (const method of methods) {
      const integration = JSON.stringify(method.Properties.Integration);
      assert.include(integration, 'DeviceApiFn');
      assert.notInclude(integration, '"ApiFn');
      assert.notInclude(integration, 'OnboardingApiFn');
    }
  });
});

describe('Device API mTLS 自定义域名（提供域名配置时）', () => {
  const template = synthTemplate({
    envName: 'test',
    deviceApiDomain: {
      domainName: 'device-api.example.com',
      certificateArn: 'arn:aws:acm:ap-southeast-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
      truststoreKey: 'truststore/ca-bundle.pem',
    },
  });

  test('创建 mTLS 自定义域名并映射 Device API', () => {
    const domains = Object.values(resourcesOfType(template, 'AWS::ApiGateway::DomainName'));
    assert.equal(domains.length, 1);
    const domain = domains[0];
    assert.equal(domain.Properties.DomainName, 'device-api.example.com');
    assert.equal(domain.Properties.SecurityPolicy, 'TLS_1_2');
    assert.deepEqual(domain.Properties.EndpointConfiguration, { Types: ['REGIONAL'] });
    const truststoreUri = JSON.stringify(domain.Properties.MutualTlsAuthentication?.TruststoreUri);
    assert.include(truststoreUri, 's3://');
    assert.include(truststoreUri, 'truststore/ca-bundle.pem');
    template.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
  });

  test('提供 mTLS 域名后禁用 Device API 默认 execute-api 入口', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'fdp-test-device-api',
      DisableExecuteApiEndpoint: true,
    });
  });

  test('仅显式 local/test 模式可保留无 mTLS 的默认入口', () => {
    const plain = synthTemplate({ envName: 'test', allowInsecureDeviceEndpointForLocal: true });
    plain.resourceCountIs('AWS::ApiGateway::DomainName', 0);
    plain.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'fdp-test-device-api',
      DisableExecuteApiEndpoint: false,
    });
  }, 15_000);

  test('dev/staging/prod 缺少 mTLS 配置或尝试开启不安全入口时失败关闭', () => {
    for (const config of [
      { envName: 'dev' },
      { envName: 'staging', allowInsecureDeviceEndpointForLocal: true as const },
      { envName: 'prod' },
    ]) {
      const app = new App();
      assert.throws(() => new AppDependenciesStack(app, `Rejected${config.envName}`, { config }), /mTLS 配置缺失/);
    }
  });
});

// ---------- 验收：凭据 / 队列 / IoT 路由 ----------

describe('验收：数据库凭据与消息管线', () => {
  const template = synthTemplate();

  test('RDS 凭据存于 Secrets Manager（KMS 加密），实例口令使用动态引用', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'fdp-test-rds-credentials',
      KmsKeyId: Match.anyValue(),
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: Match.stringLikeRegexp('fdp_admin') }),
    });
    const dbs = Object.values(resourcesOfType(template, 'AWS::RDS::DBInstance'));
    assert.equal(dbs.length, 1);
    const password = JSON.stringify(dbs[0].Properties.MasterUserPassword);
    assert.include(password, 'resolve:secretsmanager', '口令必须来自 Secrets Manager 动态引用');
    // 用户名非敏感材料，允许为字面量；口令绝不落模板
    assert.equal(dbs[0].Properties.MasterUsername, 'fdp_admin');
  });

  test('Ingress/Archive/Replay 主队列配置 DLQ，全部队列 KMS 加密', () => {
    const queues = Object.values(resourcesOfType(template, 'AWS::SQS::Queue'));
    assert.equal(queues.length, 11);
    for (const queue of queues) {
      assert.isDefined(queue.Properties.KmsMasterKeyId, `队列 ${queue.Properties.QueueName} 未配置 KMS 加密`);
    }
    const withDlq = queues.filter((q) => q.Properties.RedrivePolicy !== undefined).map((q) => q.Properties.QueueName);
    assert.deepEqual(withDlq.sort(), ['fdp-test-archive', 'fdp-test-ingress', 'fdp-test-replay']);
  });

  test('8 个 IoT Rule 按上行 Topic 路由 Ingress，Error Action 写独立错误队列', () => {
    const rules = resourcesOfType(template, 'AWS::IoT::TopicRule');
    assert.equal(Object.keys(rules).length, 8);
    const ingressQueueUrls = new Set<string>();
    const errorQueueUrls = new Set<string>();
    const topics = new Set<string>();
    for (const rule of Object.values(rules)) {
      const payload = rule.Properties.TopicRulePayload;
      const match = /FROM 'bnx\/device\/\+\/([a-z]+)'/.exec(payload.Sql as string);
      assert.isNotNull(match);
      topics.add((match as RegExpExecArray)[1] as string);
      ingressQueueUrls.add(JSON.stringify(payload.Actions[0].Sqs.QueueUrl));
      errorQueueUrls.add(JSON.stringify(payload.ErrorAction.Sqs.QueueUrl));
    }
    assert.deepEqual([...topics].sort(), [...UPLINK_TOPIC_TYPES].sort());
    assert.equal(ingressQueueUrls.size, 1, '全部上行 Rule 必须写入同一 Ingress 队列');
    assert.equal(errorQueueUrls.size, 1, '全部 Error Action 必须写入同一错误队列');
    assert.notDeepEqual([...ingressQueueUrls], [...errorQueueUrls], '错误队列必须独立于业务队列');
  });

  test('消费 Lambda 与队列事件源绑定，Outbox/Summary/Replay/证书包清理有调度', () => {
    const esms = Object.values(resourcesOfType(template, 'AWS::Lambda::EventSourceMapping'));
    assert.equal(esms.length, 3);
    for (const esm of esms) {
      assert.equal(esm.Properties.FunctionResponseTypes?.[0], 'ReportBatchItemFailures');
    }
    template.resourceCountIs('AWS::Events::Rule', 14);
    for (const name of ['fdp-test-command-publisher', 'fdp-test-command-timeout', 'fdp-test-ota-dispatcher']) {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: name,
        ScheduleExpression: 'rate(1 minute)',
        Targets: Match.arrayWith([
          Match.objectLike({ RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 } }),
        ]),
      });
    }
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-notification-publisher',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-replay-trigger-publisher',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-cert-package-sweeper',
      ScheduleExpression: 'rate(5 minutes)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-onboarding-deadline',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-onboarding-provisioning',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-retirement-timeout',
      ScheduleExpression: 'rate(5 minutes)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-activity-export',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-business-notifier',
      ScheduleExpression: 'rate(1 minute)',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'fdp-test-esg-export',
      ScheduleExpression: 'rate(1 minute)',
    });
  });
});

// ---------- Cognito 与应用配置输出 ----------

describe('Cognito 与应用配置输出', () => {
  const template = synthTemplate();

  test('User Pool：邮箱登录、软件令牌 MFA、customer_id 自定义属性、5 个 RBAC 组', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'fdp-test-admin',
      AutoVerifiedAttributes: ['email'],
      MfaConfiguration: 'OPTIONAL',
      Schema: Match.arrayWith([Match.objectLike({ Name: 'customer_id', Mutable: true })]),
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
    });
    const groups = Object.values(resourcesOfType(template, 'AWS::Cognito::UserPoolGroup')).map(
      (g) => g.Properties.GroupName,
    );
    assert.deepEqual(groups.sort(), [
      'Auditor',
      'CustomerAdmin',
      'CustomerViewer',
      'PlatformOperator',
      'PlatformSuperAdmin',
    ]);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  test('应用配置：Lambda 环境变量与 CfnOutput 输出关键资源标识', () => {
    const fns = Object.values(resourcesOfType(template, 'AWS::Lambda::Function'));
    const apiFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-api');
    assert.isDefined(apiFn);
    const env = apiFn.Properties.Environment.Variables as Record<string, unknown>;
    for (const key of [
      'DB_SECRET_ARN',
      'USER_POOL_ID',
      'USER_POOL_CLIENT_ID',
      'RAW_BUCKET_NAME',
      'OTA_BUCKET_NAME',
      'MEDIA_BUCKET_NAME',
      'EXPORT_BUCKET_NAME',
      'LICENSE_SIGNING_KEY_SECRET_ARN',
      'ENV_NAME',
    ]) {
      assert.isDefined(env[key], `API Lambda 缺少环境变量 ${key}`);
    }

    const onboardingFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-onboarding-api-handler');
    assert.isDefined(onboardingFn);
    for (const key of ['DB_SECRET_ARN', 'CERT_PACKAGE_KEY_ARN', 'FDP_AWS_ACCOUNT_ID', 'ENV_NAME']) {
      assert.isDefined(onboardingFn.Properties.Environment.Variables[key], `Onboarding Lambda 缺少环境变量 ${key}`);
    }
    const deviceFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-device-api-handler');
    assert.isDefined(deviceFn);
    for (const key of [
      'DB_SECRET_ARN',
      'CERT_PACKAGE_KEY_ARN',
      'FDP_AWS_ACCOUNT_ID',
      'OTA_BUCKET_NAME',
      'MEDIA_BUCKET_NAME',
      'ENV_NAME',
    ]) {
      assert.isDefined(deviceFn.Properties.Environment.Variables[key], `Device Lambda 缺少环境变量 ${key}`);
    }
    const otaDispatcherFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-ota-dispatcher');
    assert.isDefined(otaDispatcherFn);
    assert.isDefined(otaDispatcherFn.Properties.Environment.Variables.DEVICE_API_BASE_URL);
    assert.isUndefined(otaDispatcherFn.Properties.Environment.Variables.OTA_BUCKET_NAME);
    const ingestionFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-ingestion');
    assert.isDefined(ingestionFn);
    for (const key of [
      'DB_SECRET_ARN',
      'QUARANTINE_QUEUE_URL',
      'CERT_PACKAGE_KEY_ARN',
      'MEDIA_BUCKET_NAME',
      'MQTT_SCHEMAS_DIR',
    ]) {
      assert.isDefined(ingestionFn.Properties.Environment.Variables[key], `Ingestion Lambda 缺少环境变量 ${key}`);
    }
    const deadlineFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-onboarding-deadline');
    assert.isDefined(deadlineFn);
    assert.isDefined(deadlineFn.Properties.Environment.Variables.DB_SECRET_ARN);
    const retirementTimeoutFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-retirement-timeout');
    assert.isDefined(retirementTimeoutFn);
    assert.isDefined(retirementTimeoutFn.Properties.Environment.Variables.DB_SECRET_ARN);
    assert.equal(retirementTimeoutFn.Properties.Environment.Variables.RETIREMENT_TIMEOUT_BATCH_SIZE, '100');
    const activityExportFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-activity-export');
    assert.isDefined(activityExportFn);
    for (const key of ['DB_SECRET_ARN', 'EXPORT_BUCKET_NAME']) {
      assert.isDefined(activityExportFn.Properties.Environment.Variables[key], `Activity Export Lambda 缺少 ${key}`);
    }
    assert.equal(activityExportFn.Properties.Environment.Variables.ACTIVITY_EXPORT_BATCH_SIZE, '10');
    assert.equal(activityExportFn.Properties.Environment.Variables.ACTIVITY_EXPORT_LEASE_SECONDS, '300');
    const provisioningFn = fns.find((f) => f.Properties.FunctionName === 'fdp-test-onboarding-provisioning');
    assert.isDefined(provisioningFn);
    for (const key of ['DB_SECRET_ARN', 'CERT_PACKAGE_KEY_ARN', 'FDP_AWS_ACCOUNT_ID']) {
      assert.isDefined(provisioningFn.Properties.Environment.Variables[key], `Provisioning Lambda 缺少环境变量 ${key}`);
    }

    const outputs = template.findOutputs('*');
    for (const id of [
      'OnboardingApiUrl',
      'DeviceApiUrl',
      'AdminApiUrl',
      'UserPoolId',
      'UserPoolClientId',
      'DbSecretArn',
      'IngressQueueUrl',
      'ArchiveQueueUrl',
      'ReplayQueueUrl',
      'QuarantineQueueUrl',
      'RuleErrorQueueUrl',
      'RawBucketName',
      'OtaBucketName',
      'MediaBucketName',
      'ExportBucketName',
      'DataKeyArn',
      'CertPackageKeyArn',
      'OtaSigningKeyArn',
    ]) {
      assert.isDefined(outputs[id], `缺少 CfnOutput ${id}`);
    }
  });

  test('Admin 用户管理 IAM 仅包含所需 Cognito Admin 动作并限定当前 User Pool', () => {
    const statements = collectPolicyStatements(template.toJSON()).map(({ statement }) => statement);
    const admin = statements.find((statement) => statement.Sid === 'AdminUserManagement');
    assert.isDefined(admin);
    assert.deepEqual([...(admin.Action as string[])].sort(), [
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDeleteUser',
      'cognito-idp:AdminDeleteUserAttributes',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminResetUserPassword',
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:ListUsers',
    ]);
    assert.include(JSON.stringify(admin.Resource), 'AdminUserPool');
    assert.notEqual(admin.Resource, '*');
  });

  test('KMS：数据/证书包 Key 启用轮换；OTA 使用独立 RSA-2048 SIGN_VERIFY 信任根', () => {
    const keys = Object.values(resourcesOfType(template, 'AWS::KMS::Key'));
    assert.equal(keys.length, 3);
    assert.equal(keys.filter((key) => key.Properties.EnableKeyRotation === true).length, 2);
    assert.isDefined(
      keys.find((key) => key.Properties.KeySpec === 'RSA_2048' && key.Properties.KeyUsage === 'SIGN_VERIFY'),
    );
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/fdp-test-data' });
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/fdp-test-cert-package' });
    template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/fdp-test-ota-signing' });
  });
});
