/**
 * IAC-01 应用依赖 CDK Stack。
 *
 * 覆盖任务核心开发内容：IoT Rule、Ingress/Archive/DLQ/Quarantine SQS、Lambda、
 * RDS、S3 Raw/OTA/Media/Export、API Gateway、Cognito、KMS 和必要 IAM role，
 * 并通过 Lambda 环境变量与 CfnOutput 输出应用配置。
 *
 * 事实源对齐：
 * - Topic/QoS：contracts/mqtt/topic-catalog.json（CT-02），一致性由 topic-catalog-parity 测试强制；
 * - 数据库引擎：PostgreSQL（DB-01 落地实现与全部方案文档的统一选型）；
 * - 三类 API 认证入口分离：docs/AWS云端方案关键问题与解决方案.md §4.3
 *   （Onboarding=一次性 Token，Device=X.509 mTLS 自定义域名，Admin/Customer=Cognito JWT，Internal=IAM）。
 *
 * 功能边界（本 Stack 明确不做）：生产 Multi-AZ、备份、告警、Dashboard、Budget、
 * WAF、扩缩容和发布流水线。
 */
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { InfraConfig } from '../config.js';
import { Naming } from '../naming.js';
import { UPLINK_TOPIC_TYPES, uplinkTopicFilter } from '../topics.js';

export interface AppDependenciesStackProps extends StackProps {
  readonly config: InfraConfig;
}

/** 占位 Handler：业务实现由对应 BE 任务交付，部署包届时替换；占位实现不承诺任何契约行为。 */
const PLACEHOLDER_HANDLER_CODE = [
  '// IAC-01 placeholder; replaced by BE tasks (cloud-api / ingestion-worker / archive-worker / summary-worker)',
  'exports.handler = async () => ({ statusCode: 501, body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "handler not wired" } }) });',
].join('\n');

const DB_MASTER_USERNAME = 'fdp_admin' as const;
const API_ROLE_SUFFIX = 'api-role' as const;
const DEVICE_API_ROLE_SUFFIX = 'device-api-role' as const;
const ONBOARDING_API_ROLE_SUFFIX = 'onboarding-api-role' as const;
const ONBOARDING_PROVISIONING_ROLE_SUFFIX = 'onboarding-provisioning-role' as const;
const CERT_SWEEPER_ROLE_SUFFIX = 'cert-package-sweeper-role' as const;
const WORKSPACE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const API_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/lambda-entry.ts');
const DEVICE_API_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/device-entry.ts');
const ONBOARDING_API_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/device-onboarding-entry.ts');
const ONBOARDING_PROVISIONING_ENTRY = resolve(
  WORKSPACE_ROOT,
  'apps/cloud-api/src/runtime/onboarding-provisioning-entry.ts',
);
const CERT_SWEEPER_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/certificate-package-sweeper-entry.ts');
const INGESTION_ENTRY = resolve(WORKSPACE_ROOT, 'apps/ingestion-worker/src/runtime/ingestion-entry.ts');
const OUTBOX_PUBLISHER_ENTRY = resolve(WORKSPACE_ROOT, 'apps/ingestion-worker/src/runtime/outbox-publisher-entry.ts');
const NOTIFICATION_PUBLISHER_ENTRY = resolve(
  WORKSPACE_ROOT,
  'apps/ingestion-worker/src/runtime/notification-publisher-entry.ts',
);
const ARCHIVE_ENTRY = resolve(WORKSPACE_ROOT, 'apps/ingestion-worker/src/runtime/archive-entry.ts');
const SUMMARY_ENTRY = resolve(WORKSPACE_ROOT, 'apps/summary-worker/src/runtime/summary-entry.ts');
const REPLAY_TRIGGER_PUBLISHER_ENTRY = resolve(
  WORKSPACE_ROOT,
  'apps/ingestion-worker/src/runtime/replay-trigger-publisher-entry.ts',
);
const REPLAY_ENTRY = resolve(WORKSPACE_ROOT, 'apps/ingestion-worker/src/runtime/replay-entry.ts');
const ONBOARDING_DEADLINE_ENTRY = resolve(
  WORKSPACE_ROOT,
  'apps/ingestion-worker/src/runtime/onboarding-deadline-entry.ts',
);
const RETIREMENT_TIMEOUT_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/retirement-timeout-entry.ts');
const ACTIVITY_EXPORT_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/activity-export-entry.ts');
const BUSINESS_NOTIFIER_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/business-notifier-entry.ts');
const ESG_EXPORT_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/esg-export-entry.ts');
const COMMAND_PUBLISHER_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/command-publisher-entry.ts');
const COMMAND_TIMEOUT_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/command-timeout-entry.ts');
const OTA_DISPATCHER_ENTRY = resolve(WORKSPACE_ROOT, 'apps/cloud-api/src/runtime/ota-dispatcher-entry.ts');

interface MessagingResources {
  readonly ingress: sqs.Queue;
  readonly ingressDlq: sqs.Queue;
  readonly archive: sqs.Queue;
  readonly archiveDlq: sqs.Queue;
  readonly replay: sqs.Queue;
  readonly replayDlq: sqs.Queue;
  readonly quarantine: sqs.Queue;
  readonly ruleError: sqs.Queue;
}

interface StorageResources {
  readonly dataKey: kms.Key;
  readonly certPackageKey: kms.Key;
  readonly otaSigningKey: kms.Key;
  readonly raw: s3.Bucket;
  readonly ota: s3.Bucket;
  readonly media: s3.Bucket;
  readonly exportBucket: s3.Bucket;
  readonly truststore: s3.IBucket;
}

interface DataResources {
  readonly vpc: ec2.IVpc;
  readonly db: rds.DatabaseInstance;
  readonly dbSecretArn: string;
  readonly lambdaSecurityGroup: ec2.SecurityGroup;
}

interface ComputeResources {
  readonly ingestion: lambda.Function;
  readonly archive: lambda.Function;
  readonly outboxPublisher: lambda.Function;
  readonly notificationPublisher: lambda.Function;
  readonly summary: lambda.Function;
  readonly replayTriggerPublisher: lambda.Function;
  readonly replay: lambda.Function;
  readonly certPackageSweeper: lambda.Function;
  readonly onboardingDeadline: lambda.Function;
  readonly retirementTimeout: lambda.Function;
  readonly activityExport: lambda.Function;
  readonly esgExport: lambda.Function;
  readonly onboardingApi: lambda.Function;
  readonly onboardingProvisioning: lambda.Function;
  readonly deviceApi: lambda.Function;
  readonly api: lambda.Function;
  readonly commandPublisher: lambda.Function;
  readonly commandTimeout: lambda.Function;
  readonly otaDispatcher: lambda.Function;
}

interface IdentityResources {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
}

/** 三类认证入口：Onboarding(Token) / Device(mTLS) / Admin+Customer(Cognito) + Internal(IAM)。 */
interface ApiResources {
  readonly onboardingApi: apigw.RestApi;
  readonly deviceApi: apigw.RestApi;
  readonly adminApi: apigw.RestApi;
}

export class AppDependenciesStack extends Stack {
  private readonly config: InfraConfig;
  private readonly naming: Naming;

  constructor(scope: Construct, id: string, props: AppDependenciesStackProps) {
    super(scope, id, { ...props, stackName: new Naming(props.config.envName).name('app') });
    this.config = props.config;
    this.naming = new Naming(this.config.envName);
    if (this.config.deploymentAccount && this.config.allowInsecureDeviceEndpointForLocal) {
      throw new Error('真实部署禁止不安全 Device execute-api 入口');
    }

    if (!this.config.deviceApiDomain) {
      if (
        this.config.allowInsecureDeviceEndpointForLocal !== true ||
        !['local', 'test'].includes(this.config.envName)
      ) {
        throw new Error('Device API mTLS 配置缺失：无证书入口只允许显式 local/test 模式');
      }
    }

    Tags.of(this).add('fdp:project', 'food-digester-platform');
    Tags.of(this).add('fdp:env', this.config.envName);
    Tags.of(this).add('fdp:managed-by', 'cdk');

    const storage = this.createStorage();
    const messaging = this.createMessaging(storage.dataKey);
    this.createIotIngestionRules(messaging);
    const data = this.createData(storage.dataKey);
    if (this.config.enableMigrationRunner) this.createMigrationRunner(data);
    const identity = this.createIdentity();
    const compute = this.createCompute(storage, messaging, data, identity);
    const apis = this.createApiGateways(
      compute.onboardingApi,
      compute.deviceApi,
      compute.api,
      identity,
      storage.truststore,
    );
    compute.otaDispatcher.addEnvironment(
      'DEVICE_API_BASE_URL',
      this.config.deviceApiDomain ? `https://${this.config.deviceApiDomain.domainName}` : apis.deviceApi.url,
    );
    this.createOutputs(storage, messaging, data, identity, apis);
  }

  // ---------- KMS 与 S3 ----------

  private createMigrationRunner(data: DataResources): void {
    const source = new s3.Bucket(this, 'MigrationSource', {
      bucketName: `${this.naming.name('migration-source')}-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const sg = new ec2.SecurityGroup(this, 'MigrationRunnerSg', {
      vpc: data.vpc,
      description: 'One-shot migration runner, no inbound access',
    });
    data.db.connections.allowFrom(sg, ec2.Port.tcp(5432), 'Migration runner to private PostgreSQL');
    const runnerRole = new iam.Role(this, 'MigrationRunnerServiceRole', {
      roleName: this.naming.name('migration-runner-role'),
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'One-shot database migration CodeBuild service role',
    });
    const project = new codebuild.Project(this, 'MigrationRunner', {
      role: runnerRole,
      projectName: this.naming.name('migration-runner'),
      source: codebuild.Source.s3({ bucket: source, path: 'migration/source.zip' }),
      vpc: data.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      concurrentBuildLimit: 1,
      autoRetryLimit: 0,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'MigrationRunnerLogs', {
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: RemovalPolicy.RETAIN,
          }),
        },
      },
      timeout: Duration.minutes(20),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          DB_SECRET_ARN: { value: data.dbSecretArn },
          FDP_EXPECTED_SOURCE_COMMIT: { value: 'NOT_APPROVED' },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: 24 },
            commands: [
              'node scripts/check-migration-source.mjs',
              'npm install --global pnpm@10.20.0',
              'pnpm install --frozen-lockfile',
              'curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o rds-ca-bundle.pem',
            ],
          },
          build: { commands: ['node scripts/run-database-migrations.mjs'] },
        },
      }),
    });
    data.db.secret?.grantRead(project);
    new CfnOutput(this, 'MigrationRunnerProjectName', { value: project.projectName });
    new CfnOutput(this, 'MigrationSourceBucketName', { value: source.bucketName });
  }

  private createStorage(): StorageResources {
    // KMS 管理面只保留显式管理动作，避免 CDK 默认 `kms:*` KeyPolicy 绕过通配权限 Gate。
    const certPackageAdmin = new iam.PolicyStatement({
      sid: 'KeyAdministrationOnly',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        'kms:Create*',
        'kms:Describe*',
        'kms:Enable*',
        'kms:List*',
        'kms:Put*',
        'kms:Update*',
        'kms:Revoke*',
        'kms:Disable*',
        'kms:Get*',
        'kms:Delete*',
        'kms:TagResource',
        'kms:UntagResource',
        'kms:ScheduleKeyDeletion',
        'kms:CancelKeyDeletion',
        'kms:RotateKeyOnDemand',
      ],
      resources: ['*'],
    });
    const dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${this.naming.name('data')}`,
      description: '应用数据静态加密（SQS/S3/RDS/Secrets Manager）',
      enableKeyRotation: true,
      policy: new iam.PolicyDocument({ statements: [certPackageAdmin] }),
      // 功能边界：密钥保留策略属运维决策，开发环境允许随 Stack 销毁
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // SEC-01：证书包 Key 数据面只授予 Onboarding/Device API、Provisioning Worker 与恢复 Lambda。
    // 使用确定性角色 ARN 条件，避免 Key ↔ Lambda Role 的 CloudFormation 循环依赖。
    const onboardingApiRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(ONBOARDING_API_ROLE_SUFFIX),
    });
    const deviceApiRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(DEVICE_API_ROLE_SUFFIX),
    });
    const onboardingProvisioningRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(ONBOARDING_PROVISIONING_ROLE_SUFFIX),
    });
    const certSweeperRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(CERT_SWEEPER_ROLE_SUFFIX),
    });
    const apiRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(API_ROLE_SUFFIX),
    });
    const certPackageDataPlane = new iam.PolicyStatement({
      sid: 'CertificatePackageRuntimeDataPlaneOnly',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        ArnEquals: {
          'aws:PrincipalArn': [
            onboardingApiRoleArn,
            deviceApiRoleArn,
            onboardingProvisioningRoleArn,
            certSweeperRoleArn,
          ],
        },
      },
    });
    const certPackageKey = new kms.Key(this, 'CertPackageKey', {
      alias: `alias/${this.naming.name('cert-package')}`,
      description: '一次性证书包信封加密（DEC-003 / SEC-01）',
      enableKeyRotation: true,
      policy: new iam.PolicyDocument({ statements: [certPackageAdmin, certPackageDataPlane] }),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const otaVerifyDataPlane = new iam.PolicyStatement({
      sid: 'OtaFirmwareVerifyOnly',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['kms:Verify', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: { ArnEquals: { 'aws:PrincipalArn': apiRoleArn } },
    });
    const otaSigningKey = new kms.Key(this, 'OtaSigningKey', {
      alias: `alias/${this.naming.name('ota-signing')}`,
      description: 'DEC-022 OTA 固件 RSA-2048 签名信任根（Admin API 仅 Verify）',
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      policy: new iam.PolicyDocument({ statements: [certPackageAdmin, otaVerifyDataPlane] }),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = (id: string, suffix: string): s3.Bucket =>
      new s3.Bucket(this, id, {
        // S3 Bucket 名全局唯一：环境前缀 + 账号 ID 后缀
        bucketName: `${this.naming.name(suffix)}-${Aws.ACCOUNT_ID}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: dataKey,
        enforceSSL: true,
        versioned: true,
        // 功能边界：不配置生命周期/Object Lock/长期归档；销毁策略由环境运维决定
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: false,
      });

    const exportBucket = bucket('ExportBucket', 'export');
    exportBucket.addLifecycleRule({
      id: 'ExpireActivityExports',
      prefix: 'activity-exports/',
      expiration: Duration.days(1),
      noncurrentVersionExpiration: Duration.days(1),
      abortIncompleteMultipartUploadAfter: Duration.days(1),
    });
    exportBucket.addLifecycleRule({
      id: 'ExpireEsgExports',
      prefix: 'esg-exports/',
      expiration: Duration.days(1),
      noncurrentVersionExpiration: Duration.days(1),
      abortIncompleteMultipartUploadAfter: Duration.days(1),
    });

    const truststore = this.config.deviceApiDomain?.truststoreBucketName
      ? s3.Bucket.fromBucketName(this, 'ExistingTruststore', this.config.deviceApiDomain.truststoreBucketName)
      : bucket('TruststoreBucket', 'mtls-truststore');

    return {
      dataKey,
      certPackageKey,
      otaSigningKey,
      raw: bucket('RawBucket', 'raw'),
      ota: bucket('OtaBucket', 'ota'),
      media: bucket('MediaBucket', 'media'),
      exportBucket,
      truststore,
    };
  }

  // ---------- SQS 消息管线 ----------

  private createMessaging(dataKey: kms.IKey): MessagingResources {
    const mkQueue = (id: string, suffix: string, options: sqs.QueueProps = {}): sqs.Queue =>
      new sqs.Queue(this, id, {
        queueName: this.naming.name(suffix),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        retentionPeriod: Duration.days(4),
        ...options,
      });

    const mkDlq = (id: string, suffix: string): sqs.Queue =>
      mkQueue(id, suffix, { retentionPeriod: Duration.days(14) });

    const ingressDlq = mkDlq('IngressDlq', 'ingress-dlq');
    const archiveDlq = mkDlq('ArchiveDlq', 'archive-dlq');
    const replayDlq = mkDlq('ReplayDlq', 'replay-dlq');

    // visibilityTimeout = 消费 Lambda 超时（60s/300s）的 6 倍
    const ingress = mkQueue('IngressQueue', 'ingress', {
      visibilityTimeout: Duration.seconds(360),
      deadLetterQueue: { queue: ingressDlq, maxReceiveCount: 5 },
    });
    const archive = mkQueue('ArchiveQueue', 'archive', {
      visibilityTimeout: Duration.seconds(1800),
      deadLetterQueue: { queue: archiveDlq, maxReceiveCount: 5 },
    });
    const replay = mkQueue('ReplayQueue', 'replay', {
      visibilityTimeout: Duration.seconds(5_400),
      deadLetterQueue: { queue: replayDlq, maxReceiveCount: 5 },
    });

    // Quarantine：不可重试的 Schema/契约错误隔离（BE-IOT-02），终态队列，无下游 DLQ
    const quarantine = mkQueue('QuarantineQueue', 'quarantine', { retentionPeriod: Duration.days(14) });
    // IoT Rule 错误动作目标（规则引擎投递失败），终态队列
    const ruleError = mkQueue('IotRuleErrorQueue', 'iot-rule-error', { retentionPeriod: Duration.days(14) });

    return { ingress, ingressDlq, archive, archiveDlq, replay, replayDlq, quarantine, ruleError };
  }

  // ---------- IoT Rule：8 个上行 Topic → Ingress SQS ----------

  private createIotIngestionRules(messaging: MessagingResources): void {
    const ruleRole = new iam.Role(this, 'IotRuleRole', {
      roleName: this.naming.name('iot-rule'),
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'IoT Rule role: SendMessage only to ingress and rule-error queues',
    });
    messaging.ingress.grantSendMessages(ruleRole);
    messaging.ruleError.grantSendMessages(ruleRole);

    for (const type of UPLINK_TOPIC_TYPES) {
      const idSuffix = type.charAt(0).toUpperCase() + type.slice(1);
      // BE-IOT-01 Envelope 契约（contracts/iot/ingress-envelope.schema.json）：
      // 原始 Payload 全字段平铺（SELECT *）+ 五个 iot* 保留上下文字段；
      // 设备自报身份字段不可信，消费端只用 iotDeviceId/iotPrincipal 结合台账解析。
      const sql =
        `SELECT *, topic() AS iotTopic, topic(3) AS iotDeviceId, topic(4) AS iotType, ` +
        `timestamp() AS iotReceivedAt, principal() AS iotPrincipal ` +
        `FROM '${uplinkTopicFilter(type)}'`;
      new iot.CfnTopicRule(this, `IotRule${idSuffix}`, {
        ruleName: this.naming.iotRule(`iot-${type}`),
        topicRulePayload: {
          sql,
          awsIotSqlVersion: '2016-03-23',
          ruleDisabled: false,
          // useBase64=false：保留 JSON 原文（Envelope 平铺），不做 Base64 包装
          actions: [{ sqs: { queueUrl: messaging.ingress.queueUrl, roleArn: ruleRole.roleArn, useBase64: false } }],
          errorAction: {
            sqs: { queueUrl: messaging.ruleError.queueUrl, roleArn: ruleRole.roleArn, useBase64: false },
          },
        },
      });
    }
  }

  // ---------- VPC 与 RDS ----------

  private createData(dataKey: kms.IKey): DataResources {
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: this.naming.name('vpc'),
      maxAzs: 2,
      // 试运营成本基线：单 NAT 供 Lambda 访问 AWS 服务；扩缩容/Multi-AZ 不在本任务范围
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      securityGroupName: this.naming.name('lambda-sg'),
      description: 'Application Lambda egress to RDS and AWS services',
    });
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      securityGroupName: this.naming.name('db-sg'),
      description: 'RDS ingress: PostgreSQL 5432 from application Lambda security group only',
    });
    dbSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(5432), 'Lambda to PostgreSQL');

    // 数据库引擎以 DB-01 落地的 PostgreSQL（Prisma provider + btree_gist 排他约束）为准
    const db = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: this.naming.name('db'),
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      // 数据库凭据通过 Secrets Manager 生成与保存，静态加密使用应用数据 Key
      credentials: rds.Credentials.fromGeneratedSecret(DB_MASTER_USERNAME, {
        secretName: this.naming.name('rds-credentials'),
        encryptionKey: dataKey,
      }),
      databaseName: 'fdp',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      publiclyAccessible: false,
      // 功能边界：Multi-AZ、备份、删除保护、扩缩容均不在本任务范围
      multiAz: false,
      backupRetention: Duration.days(0),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dbSecret = db.secret;
    if (!dbSecret) {
      throw new Error('RDS 凭据 Secret 未生成');
    }
    return { vpc, db, dbSecretArn: dbSecret.secretArn, lambdaSecurityGroup };
  }

  // ---------- Cognito 身份 ----------

  private createIdentity(): IdentityResources {
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: this.naming.name('admin'),
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // MFA：池级 OPTIONAL（软件令牌）；平台管理员强制 MFA 的账号策略由 AUTH/BE-RBAC 任务收口
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Customer scope 注入载体（AUTH-01 读取 custom:customer_id）
      customAttributes: { customer_id: new cognito.StringAttribute({ mutable: true }) },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('AdminWebClient', {
      userPoolClientName: this.naming.name('admin-web'),
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      generateSecret: false,
    });

    // DEC-012 角色映射：与 RBAC 权限矩阵同名（AUTH-01/BE-RBAC-01 消费）
    const groups = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
    for (const groupName of groups) {
      new cognito.CfnUserPoolGroup(this, `UserPoolGroup${groupName}`, {
        userPoolId: userPool.userPoolId,
        groupName,
      });
    }

    return { userPool, userPoolClient };
  }

  // ---------- Lambda 计算与最小权限角色 ----------

  private createCompute(
    storage: StorageResources,
    messaging: MessagingResources,
    data: DataResources,
    identity: IdentityResources,
  ): ComputeResources {
    const mkFunction = (
      id: string,
      suffix: string,
      options: {
        timeout: Duration;
        memorySize?: number;
        environment: Record<string, string>;
        role?: iam.IRole;
        entry?: string;
        copyMqttSchemas?: boolean;
      },
    ): lambda.Function => {
      const functionRole =
        options.role ??
        new iam.Role(this, `${id}ServiceRole`, {
          roleName: this.naming.name(`${suffix}-role`),
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          description: `${this.naming.name(suffix)} Lambda execution role`,
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
          ],
        });
      const props = {
        functionName: this.naming.name(suffix),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: options.timeout,
        memorySize: options.memorySize ?? 256,
        environment: { ...options.environment, ENV_NAME: this.config.envName },
        role: functionRole,
        vpc: data.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [data.lambdaSecurityGroup],
      };
      if (options.entry) {
        return new lambdaNodejs.NodejsFunction(this, id, {
          ...props,
          entry: options.entry,
          handler: 'handler',
          depsLockFilePath: resolve(WORKSPACE_ROOT, 'pnpm-lock.yaml'),
          projectRoot: WORKSPACE_ROOT,
          bundling: {
            target: 'node24',
            sourceMap: true,
            format: lambdaNodejs.OutputFormat.ESM,
            logLevel: lambdaNodejs.LogLevel.ERROR,
            ...(options.copyMqttSchemas
              ? {
                  commandHooks: {
                    beforeBundling: () => [],
                    beforeInstall: () => [],
                    afterBundling: (inputDir: string, outputDir: string) => [
                      `cp -R "${inputDir}/contracts/mqtt/schemas" "${outputDir}/mqtt-schemas"`,
                    ],
                  },
                }
              : {}),
          },
        });
      }
      return new lambda.Function(this, id, {
        ...props,
        handler: 'index.handler',
        code: lambda.Code.fromInline(PLACEHOLDER_HANDLER_CODE),
      });
    };

    const dbSecret = data.dbSecretArn;
    const dbSecretGrant = (fn: lambda.IFunction): void => {
      // grantRead 同时授予 Secret 加密 Key 的 kms:Decrypt（仅限 dataKey）
      data.db.secret?.grantRead(fn);
    };
    const scheduleWithDlq = (id: string, suffix: string, fn: lambda.Function): void => {
      const dlq = new sqs.Queue(this, `${id}Dlq`, {
        queueName: this.naming.name(`${suffix}-dlq`),
        encryption: sqs.QueueEncryption.KMS_MANAGED,
        retentionPeriod: Duration.days(14),
      });
      new events.Rule(this, `${id}Schedule`, {
        ruleName: this.naming.name(suffix),
        enabled: this.config.enableScheduledWorkers === true,
        schedule: events.Schedule.rate(Duration.minutes(1)),
        targets: [
          new eventsTargets.LambdaFunction(fn, {
            deadLetterQueue: dlq,
            retryAttempts: 2,
            maxEventAge: Duration.hours(1),
          }),
        ],
      });
      new cloudwatch.Alarm(this, `${id}ErrorsAlarm`, {
        alarmName: this.naming.name(`${suffix}-errors`),
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      });
      new cloudwatch.Alarm(this, `${id}DlqAlarm`, {
        alarmName: this.naming.name(`${suffix}-dlq-visible`),
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    };
    const licenseSigningKey = new secretsmanager.Secret(this, 'LicenseSigningKey', {
      secretName: this.naming.name('license-signing-key'),
      encryptionKey: storage.dataKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // Ingestion Worker：消费 Ingress，隔离坏消息到 Quarantine（BE-IOT-02）
    const ingestion = mkFunction('IngestionFn', 'ingestion', {
      timeout: Duration.seconds(60),
      environment: {
        DB_SECRET_ARN: dbSecret,
        QUARANTINE_QUEUE_URL: messaging.quarantine.queueUrl,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
        MEDIA_BUCKET_NAME: storage.media.bucketName,
        MQTT_SCHEMAS_DIR: '/var/task/mqtt-schemas',
      },
      entry: INGESTION_ENTRY,
      copyMqttSchemas: true,
    });
    ingestion.addEventSource(
      new lambdaEventSources.SqsEventSource(messaging.ingress, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    messaging.quarantine.grantSendMessages(ingestion);
    storage.media.grantRead(ingestion);
    ingestion.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OnboardingHeartbeatCertificateRevoke',
        actions: ['iot:UpdateCertificate'],
        resources: [this.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );
    dbSecretGrant(ingestion);

    // Archive Worker：消费 Archive，写 Raw Bucket（BE-ARC-02）
    const archive = mkFunction('ArchiveFn', 'archive', {
      timeout: Duration.seconds(300),
      environment: { RAW_BUCKET_NAME: storage.raw.bucketName },
      entry: ARCHIVE_ENTRY,
    });
    archive.addEventSource(
      new lambdaEventSources.SqsEventSource(messaging.archive, {
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(30),
        reportBatchItemFailures: true,
      }),
    );
    storage.raw.grantWrite(archive);

    // Archive Outbox Publisher：严格只消费 ARCHIVE，事务性 Outbox → Archive SQS。
    const outboxPublisher = mkFunction('OutboxPublisherFn', 'outbox-publisher', {
      timeout: Duration.seconds(60),
      environment: {
        DB_SECRET_ARN: dbSecret,
        ARCHIVE_QUEUE_URL: messaging.archive.queueUrl,
      },
      entry: OUTBOX_PUBLISHER_ENTRY,
    });
    messaging.archive.grantSendMessages(outboxPublisher);
    dbSecretGrant(outboxPublisher);
    new events.Rule(this, 'OutboxPublisherSchedule', {
      ruleName: this.naming.name('outbox-publisher'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(outboxPublisher)],
    });

    // Notification Publisher：独立消费 CT-04 通知事件，仅持有 IoT Publish 权限。
    const notificationPublisher = mkFunction('NotificationPublisherFn', 'notification-publisher', {
      timeout: Duration.seconds(60),
      environment: { DB_SECRET_ARN: dbSecret },
      entry: NOTIFICATION_PUBLISHER_ENTRY,
    });
    dbSecretGrant(notificationPublisher);
    notificationPublisher.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IotDataEndpointDiscovery',
        actions: ['iot:DescribeEndpoint'],
        resources: ['*'],
      }),
    );
    notificationPublisher.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DeviceNotificationPublish',
        actions: ['iot:Publish'],
        resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'bnx/device/*/notification' })],
      }),
    );
    new events.Rule(this, 'NotificationPublisherSchedule', {
      ruleName: this.naming.name('notification-publisher'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(notificationPublisher)],
    });

    // Summary Worker：小时/日聚合（BE-ESG-01）
    const summary = mkFunction('SummaryFn', 'summary', {
      timeout: Duration.seconds(300),
      environment: { DB_SECRET_ARN: dbSecret, SUMMARY_LOOKBACK_HOURS: '48' },
      entry: SUMMARY_ENTRY,
    });
    dbSecretGrant(summary);
    new events.Rule(this, 'SummarySchedule', {
      ruleName: this.naming.name('summary'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(summary)],
    });

    // Replay：创建事务 Outbox → 专用触发队列 → S3 Raw 读取并重新投入 Ingress。
    const replayTriggerPublisher = mkFunction('ReplayTriggerPublisherFn', 'replay-trigger-publisher', {
      timeout: Duration.seconds(60),
      environment: { DB_SECRET_ARN: dbSecret, REPLAY_QUEUE_URL: messaging.replay.queueUrl },
      entry: REPLAY_TRIGGER_PUBLISHER_ENTRY,
    });
    dbSecretGrant(replayTriggerPublisher);
    messaging.replay.grantSendMessages(replayTriggerPublisher);
    new events.Rule(this, 'ReplayTriggerPublisherSchedule', {
      ruleName: this.naming.name('replay-trigger-publisher'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(replayTriggerPublisher)],
    });

    const replay = mkFunction('ReplayFn', 'replay', {
      timeout: Duration.seconds(900),
      memorySize: 512,
      environment: {
        DB_SECRET_ARN: dbSecret,
        RAW_BUCKET_NAME: storage.raw.bucketName,
        INGRESS_QUEUE_URL: messaging.ingress.queueUrl,
        FDP_AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
        AWS_PARTITION: Aws.PARTITION,
      },
      entry: REPLAY_ENTRY,
    });
    replay.addEventSource(
      new lambdaEventSources.SqsEventSource(messaging.replay, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    dbSecretGrant(replay);
    storage.raw.grantRead(replay);
    messaging.ingress.grantSendMessages(replay);

    // 管理 API、Device API、Onboarding API、Provisioning Worker 与证书恢复使用确定性的独立最小权限角色。
    const apiRole = new iam.Role(this, 'ApiFnServiceRole', {
      roleName: this.naming.name(API_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Admin API Lambda execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const onboardingApiRole = new iam.Role(this, 'OnboardingApiFnServiceRole', {
      roleName: this.naming.name(ONBOARDING_API_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Onboarding Token API execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const deviceApiRole = new iam.Role(this, 'DeviceApiFnServiceRole', {
      roleName: this.naming.name(DEVICE_API_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Device mTLS API execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const onboardingProvisioningRole = new iam.Role(this, 'OnboardingProvisioningFnServiceRole', {
      roleName: this.naming.name(ONBOARDING_PROVISIONING_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Onboarding provisioning job worker execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const certSweeperRole = new iam.Role(this, 'CertPackageSweeperFnServiceRole', {
      roleName: this.naming.name(CERT_SWEEPER_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Certificate package expiry recovery Lambda execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // SEC-01：真实 EventBridge 组合根，执行持久化恢复意图 -> AWS 撤证 -> 清包 -> 重签。
    const certPackageSweeper = mkFunction('CertPackageSweeperFn', 'cert-package-sweeper', {
      timeout: Duration.seconds(300),
      environment: {
        DB_SECRET_ARN: dbSecret,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
        FDP_AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
      },
      role: certSweeperRole,
      entry: CERT_SWEEPER_ENTRY,
    });
    dbSecretGrant(certPackageSweeper);
    certSweeperRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CertificatePackageKeyDataPlane',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [storage.certPackageKey.keyArn],
      }),
    );
    certSweeperRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'IotCertificateRecovery',
        actions: [
          'iot:CreateThing',
          'iot:CreateKeysAndCertificate',
          'iot:CreatePolicy',
          'iot:AttachPolicy',
          'iot:AttachThingPrincipal',
          'iot:UpdateCertificate',
          'iot:TagResource',
        ],
        resources: ['*'],
      }),
    );
    new events.Rule(this, 'CertPackageSweeperSchedule', {
      ruleName: this.naming.name('cert-package-sweeper'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(certPackageSweeper)],
    });

    const onboardingDeadline = mkFunction('OnboardingDeadlineFn', 'onboarding-deadline', {
      timeout: Duration.seconds(300),
      environment: {
        DB_SECRET_ARN: dbSecret,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
      },
      entry: ONBOARDING_DEADLINE_ENTRY,
    });
    dbSecretGrant(onboardingDeadline);
    onboardingDeadline.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'OnboardingDeadlineCertificateRevoke',
        actions: ['iot:UpdateCertificate'],
        resources: [this.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );
    new events.Rule(this, 'OnboardingDeadlineSchedule', {
      ruleName: this.naming.name('onboarding-deadline'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(onboardingDeadline)],
    });

    const retirementTimeout = mkFunction('RetirementTimeoutFn', 'retirement-timeout', {
      timeout: Duration.seconds(300),
      environment: { DB_SECRET_ARN: dbSecret, RETIREMENT_TIMEOUT_BATCH_SIZE: '100' },
      entry: RETIREMENT_TIMEOUT_ENTRY,
    });
    dbSecretGrant(retirementTimeout);
    retirementTimeout.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RetirementTimeoutCertificateDeactivate',
        actions: ['iot:UpdateCertificate'],
        resources: [this.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );
    new events.Rule(this, 'RetirementTimeoutSchedule', {
      ruleName: this.naming.name('retirement-timeout'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(retirementTimeout)],
    });

    const activityExport = mkFunction('ActivityExportFn', 'activity-export', {
      timeout: Duration.seconds(300),
      environment: {
        DB_SECRET_ARN: dbSecret,
        EXPORT_BUCKET_NAME: storage.exportBucket.bucketName,
        ACTIVITY_EXPORT_BATCH_SIZE: '10',
        ACTIVITY_EXPORT_LEASE_SECONDS: '300',
      },
      entry: ACTIVITY_EXPORT_ENTRY,
    });
    dbSecretGrant(activityExport);
    storage.exportBucket.grantReadWrite(activityExport, 'activity-exports/*');
    new events.Rule(this, 'ActivityExportSchedule', {
      ruleName: this.naming.name('activity-export'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(activityExport)],
    });

    if (this.config.enableBusinessNotifications !== false) {
      const businessNotifier = mkFunction('BusinessNotifierFn', 'business-notifier', {
        timeout: Duration.seconds(60),
        environment: {
          DB_SECRET_ARN: dbSecret,
          BUSINESS_EMAIL_FROM: this.config.businessEmailFrom ?? 'notifications@example.test',
          BUSINESS_WEBHOOK_ALLOWED_HOSTS: (this.config.businessWebhookAllowedHosts ?? ['webhook.example.test']).join(
            ',',
          ),
          BUSINESS_NOTIFICATION_BATCH_SIZE: '50',
          BUSINESS_NOTIFICATION_MAX_ATTEMPTS: '5',
          BUSINESS_NOTIFICATION_LEASE_SECONDS: '60',
        },
        entry: BUSINESS_NOTIFIER_ENTRY,
      });
      dbSecretGrant(businessNotifier);
      businessNotifier.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'BusinessNotificationEmailSend',
          actions: ['ses:SendEmail'],
          resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
        }),
      );
      new events.Rule(this, 'BusinessNotifierSchedule', {
        ruleName: this.naming.name('business-notifier'),
        enabled: this.config.enableScheduledWorkers === true,
        schedule: events.Schedule.rate(Duration.minutes(1)),
        targets: [new eventsTargets.LambdaFunction(businessNotifier)],
      });
    }

    const esgExport = mkFunction('EsgExportFn', 'esg-export', {
      timeout: Duration.seconds(300),
      environment: {
        DB_SECRET_ARN: dbSecret,
        EXPORT_BUCKET_NAME: storage.exportBucket.bucketName,
        ESG_EXPORT_BATCH_SIZE: '10',
        ESG_EXPORT_LEASE_SECONDS: '300',
      },
      entry: ESG_EXPORT_ENTRY,
    });
    dbSecretGrant(esgExport);
    storage.exportBucket.grantReadWrite(esgExport, 'esg-exports/*');
    new events.Rule(this, 'EsgExportSchedule', {
      ruleName: this.naming.name('esg-export'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(esgExport)],
    });

    const commandPublisher = mkFunction('CommandPublisherFn', 'command-publisher', {
      timeout: Duration.seconds(60),
      environment: { DB_SECRET_ARN: dbSecret },
      entry: COMMAND_PUBLISHER_ENTRY,
    });
    dbSecretGrant(commandPublisher);
    commandPublisher.addToRolePolicy(
      new iam.PolicyStatement({ sid: 'IotDataEndpointDiscovery', actions: ['iot:DescribeEndpoint'], resources: ['*'] }),
    );
    commandPublisher.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DeviceCommandPublish',
        actions: ['iot:Publish'],
        resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'bnx/device/*/cmd' })],
      }),
    );
    scheduleWithDlq('CommandPublisher', 'command-publisher', commandPublisher);

    const commandTimeout = mkFunction('CommandTimeoutFn', 'command-timeout', {
      timeout: Duration.seconds(60),
      environment: { DB_SECRET_ARN: dbSecret },
      entry: COMMAND_TIMEOUT_ENTRY,
    });
    dbSecretGrant(commandTimeout);
    scheduleWithDlq('CommandTimeout', 'command-timeout', commandTimeout);

    const otaDispatcher = mkFunction('OtaDispatcherFn', 'ota-dispatcher', {
      timeout: Duration.seconds(300),
      environment: { DB_SECRET_ARN: dbSecret },
      entry: OTA_DISPATCHER_ENTRY,
    });
    dbSecretGrant(otaDispatcher);
    otaDispatcher.addToRolePolicy(
      new iam.PolicyStatement({ sid: 'IotDataEndpointDiscovery', actions: ['iot:DescribeEndpoint'], resources: ['*'] }),
    );
    otaDispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DeviceOtaPublish',
        actions: ['iot:Publish'],
        resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: 'bnx/device/*/ota' })],
      }),
    );
    scheduleWithDlq('OtaDispatcher', 'ota-dispatcher', otaDispatcher);

    const onboardingApi = mkFunction('OnboardingApiFn', 'onboarding-api-handler', {
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        DB_SECRET_ARN: dbSecret,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
        FDP_AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
      },
      role: onboardingApiRole,
      entry: ONBOARDING_API_ENTRY,
    });
    dbSecretGrant(onboardingApi);
    onboardingApiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CertificatePackageKeyDataPlane',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [storage.certPackageKey.keyArn],
      }),
    );
    onboardingApi.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IotProvisioning',
        actions: [
          'iot:CreateThing',
          'iot:DescribeThing',
          'iot:DeleteThing',
          'iot:CreateKeysAndCertificate',
          'iot:DescribeCertificate',
          'iot:UpdateCertificate',
          'iot:DeleteCertificate',
          'iot:CreatePolicy',
          'iot:AttachPolicy',
          'iot:AttachThingPrincipal',
          'iot:DetachThingPrincipal',
          'iot:DescribeEndpoint',
          'iot:TagResource',
        ],
        resources: ['*'],
      }),
    );

    const onboardingProvisioning = mkFunction('OnboardingProvisioningFn', 'onboarding-provisioning', {
      timeout: Duration.seconds(300),
      environment: {
        DB_SECRET_ARN: dbSecret,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
        FDP_AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
      },
      role: onboardingProvisioningRole,
      entry: ONBOARDING_PROVISIONING_ENTRY,
    });
    dbSecretGrant(onboardingProvisioning);
    onboardingProvisioningRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CertificatePackageKeyDataPlane',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [storage.certPackageKey.keyArn],
      }),
    );
    onboardingProvisioning.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IotProvisioning',
        actions: [
          'iot:CreateThing',
          'iot:DescribeThing',
          'iot:DeleteThing',
          'iot:CreateKeysAndCertificate',
          'iot:DescribeCertificate',
          'iot:UpdateCertificate',
          'iot:DeleteCertificate',
          'iot:CreatePolicy',
          'iot:AttachPolicy',
          'iot:AttachThingPrincipal',
          'iot:DetachThingPrincipal',
          'iot:TagResource',
        ],
        resources: ['*'],
      }),
    );
    new events.Rule(this, 'OnboardingProvisioningSchedule', {
      ruleName: this.naming.name('onboarding-provisioning'),
      enabled: this.config.enableScheduledWorkers === true,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(onboardingProvisioning)],
    });

    // Device API：AUTH-03 mTLS 白名单后的证书查询/轮换、同步与退役确认。
    const deviceApi = mkFunction('DeviceApiFn', 'device-api-handler', {
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        DB_SECRET_ARN: dbSecret,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
        FDP_AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
        OTA_BUCKET_NAME: storage.ota.bucketName,
        MEDIA_BUCKET_NAME: storage.media.bucketName,
      },
      role: deviceApiRole,
      entry: DEVICE_API_ENTRY,
    });
    dbSecretGrant(deviceApi);
    storage.ota.grantRead(deviceApi, 'firmware-packages/*');
    storage.media.grantWrite(deviceApi, 'media/*');
    deviceApiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CertificatePackageKeyDataPlane',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [storage.certPackageKey.keyArn],
      }),
    );
    deviceApi.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IotCertificateRotation',
        actions: ['iot:CreateKeysAndCertificate', 'iot:CreatePolicy', 'iot:AttachPolicy', 'iot:AttachThingPrincipal'],
        resources: ['*'],
      }),
    );
    deviceApi.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DeviceRetirementCertificateDeactivate',
        actions: ['iot:UpdateCertificate'],
        resources: [this.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );

    // API Handler：AUTH-01 JWT 重新验签后路由真实 Onboarding 管理 Handler。
    const api = mkFunction('ApiFn', 'api', {
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        ADMIN_WEB_ORIGIN: this.config.adminWebOrigin ?? '',
        DB_SECRET_ARN: dbSecret,
        USER_POOL_ID: identity.userPool.userPoolId,
        USER_POOL_CLIENT_ID: identity.userPoolClient.userPoolClientId,
        RAW_BUCKET_NAME: storage.raw.bucketName,
        OTA_BUCKET_NAME: storage.ota.bucketName,
        OTA_SIGNING_KEY_ARN: storage.otaSigningKey.keyArn,
        MEDIA_BUCKET_NAME: storage.media.bucketName,
        EXPORT_BUCKET_NAME: storage.exportBucket.bucketName,
        LICENSE_SIGNING_KEY_SECRET_ARN: licenseSigningKey.secretArn,
      },
      role: apiRole,
      entry: API_ENTRY,
    });
    dbSecretGrant(api);
    licenseSigningKey.grantRead(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AdminRetirementCertificateDeactivate',
        actions: ['iot:UpdateCertificate'],
        resources: [this.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );
    // Media 管理端只签发下载 URL；上传由 mTLS Device API 独立承担。
    storage.media.grantRead(api, 'media/*');
    storage.ota.grantReadWrite(api);
    apiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'OtaFirmwareSignatureVerify',
        actions: ['kms:Verify'],
        resources: [storage.otaSigningKey.keyArn],
      }),
    );
    storage.exportBucket.grantRead(api, 'activity-exports/*');
    storage.raw.grantRead(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AdminUserManagement',
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:ListUsers',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminDeleteUserAttributes',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminResetUserPassword',
        ],
        resources: [identity.userPool.userPoolArn],
      }),
    );
    return {
      ingestion,
      archive,
      outboxPublisher,
      notificationPublisher,
      summary,
      replayTriggerPublisher,
      replay,
      certPackageSweeper,
      onboardingDeadline,
      retirementTimeout,
      activityExport,
      esgExport,
      onboardingApi,
      onboardingProvisioning,
      deviceApi,
      api,
      commandPublisher,
      commandTimeout,
      otaDispatcher,
    };
  }

  // ---------- API Gateway：三类认证入口分离 ----------

  private createApiGateways(
    onboardingApiFn: lambda.IFunction,
    deviceApiFn: lambda.IFunction,
    apiFn: lambda.IFunction,
    identity: IdentityResources,
    truststore: s3.IBucket,
  ): ApiResources {
    const onboardingIntegration = new apigw.LambdaIntegration(onboardingApiFn, { proxy: true });
    const deviceIntegration = new apigw.LambdaIntegration(deviceApiFn, { proxy: true });
    const integration = new apigw.LambdaIntegration(apiFn, { proxy: true });
    const stageOptions: apigw.StageOptions = { stageName: this.config.envName };

    // 入口 1：Onboarding API —— 一次性 Token（应用层校验，AUTH-02），不带 mTLS/Cognito
    const onboardingApi = new apigw.RestApi(this, 'OnboardingApi', {
      restApiName: this.naming.name('onboarding-api'),
      description: 'Onboarding API：一次性 Token 认证（AUTH-02），独立于 mTLS 入口',
      cloudWatchRole: false,
      disableExecuteApiEndpoint: !!this.config.onboardingApiDomain,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { ...stageOptions, throttlingRateLimit: 20, throttlingBurstLimit: 40 },
    });
    onboardingApi.root
      .addResource('api')
      .addResource('v1')
      .addResource('device')
      .addProxy({ defaultIntegration: onboardingIntegration, anyMethod: true });

    // 入口 2：Device API —— X.509 mTLS（自定义域名 truststore）；提供域名配置后禁用默认入口
    const deviceApi = new apigw.RestApi(this, 'DeviceApi', {
      restApiName: this.naming.name('device-api'),
      description: 'Device API：X.509 mTLS 自定义域名入口（AUTH-03 应用层白名单）',
      cloudWatchRole: false,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      disableExecuteApiEndpoint: this.config.allowInsecureDeviceEndpointForLocal !== true,
      deployOptions: stageOptions,
    });
    deviceApi.root
      .addResource('api')
      .addResource('v1')
      .addResource('device')
      .addProxy({ defaultIntegration: deviceIntegration, anyMethod: true });

    const deviceApiDomain = this.config.deviceApiDomain;
    if (deviceApiDomain) {
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        'DeviceApiCertificate',
        deviceApiDomain.certificateArn,
      );
      const domain = new apigw.DomainName(this, 'DeviceApiDomain', {
        domainName: deviceApiDomain.domainName,
        certificate,
        endpointType: apigw.EndpointType.REGIONAL,
        securityPolicy: apigw.SecurityPolicy.TLS_1_2,
        mtls: {
          bucket: truststore,
          key: deviceApiDomain.truststoreKey,
          version: deviceApiDomain.truststoreVersion,
        },
      });
      domain.addBasePathMapping(deviceApi, { stage: deviceApi.deploymentStage });
      new CfnOutput(this, 'DeviceApiDomainTarget', { value: domain.domainNameAliasDomainName });
      new CfnOutput(this, 'DeviceApiDomainHostedZoneId', { value: domain.domainNameAliasHostedZoneId });
    }

    // 入口 3：Admin API —— Cognito JWT（/admin、/customer）与 IAM（/internal，仅限云端任务）
    const adminApi = new apigw.RestApi(this, 'AdminApi', {
      restApiName: this.naming.name('admin-api'),
      description: 'Admin/Customer/Internal API：Cognito JWT + IAM（AUTH-01）',
      cloudWatchRole: false,
      disableExecuteApiEndpoint: !!this.config.adminApiDomain,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: stageOptions,
    });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'AdminApiAuthorizer', {
      authorizerName: this.naming.name('cognito'),
      cognitoUserPools: [identity.userPool],
      resultsCacheTtl: Duration.minutes(5),
    });
    const v1 = adminApi.root.addResource('api').addResource('v1');
    const cognitoMethodOptions: apigw.MethodOptions = {
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizer,
    };
    const adminProxy = v1
      .addResource('admin')
      .addProxy({ defaultIntegration: integration, defaultMethodOptions: cognitoMethodOptions });
    const customerProxy = v1.addResource('customer').addProxy({
      defaultIntegration: integration,
      defaultMethodOptions: cognitoMethodOptions,
    });
    if (this.config.adminWebOrigin) {
      for (const resource of [adminProxy, customerProxy]) {
        resource.addMethod('OPTIONS', integration, {
          authorizationType: apigw.AuthorizationType.NONE,
          authorizer: undefined,
        });
      }
      for (const [id, type] of [
        ['Cors4xx', apigw.ResponseType.DEFAULT_4XX],
        ['Cors5xx', apigw.ResponseType.DEFAULT_5XX],
      ] as const) {
        adminApi.addGatewayResponse(id, {
          type,
          responseHeaders: {
            'Access-Control-Allow-Origin': `'${this.config.adminWebOrigin}'`,
            Vary: "'Origin'",
          },
        });
      }
    }
    v1.addResource('internal').addProxy({
      defaultIntegration: integration,
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
    });

    for (const [id, api, domainConfig] of [
      ['AdminApiDomain', adminApi, this.config.adminApiDomain],
      ['OnboardingApiDomain', onboardingApi, this.config.onboardingApiDomain],
    ] as const) {
      if (!domainConfig) continue;
      const domain = new apigw.DomainName(this, id, {
        domainName: domainConfig.domainName,
        certificate: acm.Certificate.fromCertificateArn(this, `${id}Certificate`, domainConfig.certificateArn),
        endpointType: apigw.EndpointType.REGIONAL,
        securityPolicy: apigw.SecurityPolicy.TLS_1_2,
      });
      domain.addBasePathMapping(api, { stage: api.deploymentStage });
      new CfnOutput(this, `${id}Target`, { value: domain.domainNameAliasDomainName });
      new CfnOutput(this, `${id}HostedZoneId`, { value: domain.domainNameAliasHostedZoneId });
    }
    return { onboardingApi, deviceApi, adminApi };
  }

  // ---------- 应用配置输出 ----------

  private createOutputs(
    storage: StorageResources,
    messaging: MessagingResources,
    data: DataResources,
    identity: IdentityResources,
    apis: ApiResources,
  ): void {
    const output = (id: string, value: string, description: string): void => {
      new CfnOutput(this, id, { value, description });
    };

    // 默认 execute-api URL；Device API 生产入口为 mTLS 自定义域名（DeviceApiDomain 映射）
    output(
      'OnboardingApiUrl',
      this.config.onboardingApiDomain
        ? `https://${this.config.onboardingApiDomain.domainName}/`
        : apis.onboardingApi.url,
      'Onboarding API 入口（Token）',
    );
    output(
      'DeviceApiUrl',
      this.config.deviceApiDomain ? `https://${this.config.deviceApiDomain.domainName}/` : apis.deviceApi.url,
      'Device API 有效入口（mTLS 自定义域名）',
    );
    if (this.config.adminWebOrigin) output('AdminWebOrigin', this.config.adminWebOrigin, '管理 Web 精确 CORS Origin');
    output(
      'AdminApiUrl',
      this.config.adminApiDomain ? `https://${this.config.adminApiDomain.domainName}/` : apis.adminApi.url,
      'Admin/Customer/Internal API 入口（Cognito/IAM）',
    );
    output('UserPoolId', identity.userPool.userPoolId, 'Cognito User Pool');
    output('UserPoolClientId', identity.userPoolClient.userPoolClientId, 'Cognito Admin Web Client');
    output('DbSecretArn', data.dbSecretArn, 'RDS 凭据 Secret（Secrets Manager）');
    output('DbEndpointAddress', data.db.instanceEndpoint.hostname, 'RDS 连接地址');
    output('IngressQueueUrl', messaging.ingress.queueUrl, 'Ingress SQS');
    output('ArchiveQueueUrl', messaging.archive.queueUrl, 'Archive SQS');
    output('ReplayQueueUrl', messaging.replay.queueUrl, 'Replay job SQS');
    output('QuarantineQueueUrl', messaging.quarantine.queueUrl, 'Quarantine SQS');
    output('RuleErrorQueueUrl', messaging.ruleError.queueUrl, 'IoT Rule Error SQS');
    output('RawBucketName', storage.raw.bucketName, 'S3 Raw 归档');
    output('OtaBucketName', storage.ota.bucketName, 'S3 OTA 包');
    output('MediaBucketName', storage.media.bucketName, 'S3 Media 文件');
    output('ExportBucketName', storage.exportBucket.bucketName, 'S3 导出文件');
    output('TruststoreBucketName', storage.truststore.bucketName, 'S3 mTLS truststore');
    output('DataKeyArn', storage.dataKey.keyArn, 'KMS 应用数据 Key');
    output('CertPackageKeyArn', storage.certPackageKey.keyArn, 'KMS 证书包信封加密 Key');
    output('OtaSigningKeyArn', storage.otaSigningKey.keyArn, 'DEC-022 OTA 固件签名信任根 Key');
  }
}
