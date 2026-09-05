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
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { InfraConfig } from '../config.js';
import { Naming } from '../naming.js';
import { DOWNLINK_TOPIC_TYPES, UPLINK_TOPIC_TYPES, uplinkTopicFilter } from '../topics.js';

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

interface MessagingResources {
  readonly ingress: sqs.Queue;
  readonly ingressDlq: sqs.Queue;
  readonly archive: sqs.Queue;
  readonly archiveDlq: sqs.Queue;
  readonly quarantine: sqs.Queue;
  readonly ruleError: sqs.Queue;
}

interface StorageResources {
  readonly dataKey: kms.Key;
  readonly certPackageKey: kms.Key;
  readonly raw: s3.Bucket;
  readonly ota: s3.Bucket;
  readonly media: s3.Bucket;
  readonly exportBucket: s3.Bucket;
  readonly truststore: s3.Bucket;
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
  readonly summary: lambda.Function;
  readonly certPackageSweeper: lambda.Function;
  readonly api: lambda.Function;
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
    const identity = this.createIdentity();
    const compute = this.createCompute(storage, messaging, data, identity);
    const apis = this.createApiGateways(compute.api, identity, storage.truststore);
    this.createOutputs(storage, messaging, data, identity, apis);
  }

  // ---------- KMS 与 S3 ----------

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

    // SEC-01 前置：一次性证书包信封加密专用 Key；解密权限只授予 API Lambda（见 createCompute）
    // 使用确定性角色 ARN 条件，避免 Key ↔ Lambda Role 的 CloudFormation 循环依赖。
    const apiRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: this.naming.name(API_ROLE_SUFFIX),
    });
    const certPackageDataPlane = new iam.PolicyStatement({
      sid: 'ApiLambdaCertificatePackageDataPlaneOnly',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: { ArnEquals: { 'aws:PrincipalArn': apiRoleArn } },
    });
    const certPackageKey = new kms.Key(this, 'CertPackageKey', {
      alias: `alias/${this.naming.name('cert-package')}`,
      description: '一次性证书包信封加密（DEC-003 / SEC-01）',
      enableKeyRotation: true,
      policy: new iam.PolicyDocument({ statements: [certPackageAdmin, certPackageDataPlane] }),
      removalPolicy: RemovalPolicy.DESTROY,
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

    return {
      dataKey,
      certPackageKey,
      raw: bucket('RawBucket', 'raw'),
      ota: bucket('OtaBucket', 'ota'),
      media: bucket('MediaBucket', 'media'),
      exportBucket: bucket('ExportBucket', 'export'),
      truststore: bucket('TruststoreBucket', 'mtls-truststore'),
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

    // visibilityTimeout = 消费 Lambda 超时（60s/300s）的 6 倍
    const ingress = mkQueue('IngressQueue', 'ingress', {
      visibilityTimeout: Duration.seconds(360),
      deadLetterQueue: { queue: ingressDlq, maxReceiveCount: 5 },
    });
    const archive = mkQueue('ArchiveQueue', 'archive', {
      visibilityTimeout: Duration.seconds(1800),
      deadLetterQueue: { queue: archiveDlq, maxReceiveCount: 5 },
    });

    // Quarantine：不可重试的 Schema/契约错误隔离（BE-IOT-02），终态队列，无下游 DLQ
    const quarantine = mkQueue('QuarantineQueue', 'quarantine', { retentionPeriod: Duration.days(14) });
    // IoT Rule 错误动作目标（规则引擎投递失败），终态队列
    const ruleError = mkQueue('IotRuleErrorQueue', 'iot-rule-error', { retentionPeriod: Duration.days(14) });

    return { ingress, ingressDlq, archive, archiveDlq, quarantine, ruleError };
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
      options: { timeout: Duration; memorySize?: number; environment: Record<string, string>; role?: iam.IRole },
    ): lambda.Function =>
      new lambda.Function(this, id, {
        functionName: this.naming.name(suffix),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromInline(PLACEHOLDER_HANDLER_CODE),
        timeout: options.timeout,
        memorySize: options.memorySize ?? 256,
        environment: { ...options.environment, ENV_NAME: this.config.envName },
        ...(options.role ? { role: options.role } : {}),
        vpc: data.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [data.lambdaSecurityGroup],
      });

    const dbSecret = data.dbSecretArn;
    const dbSecretGrant = (fn: lambda.IFunction): void => {
      // grantRead 同时授予 Secret 加密 Key 的 kms:Decrypt（仅限 dataKey）
      data.db.secret?.grantRead(fn);
    };

    // Ingestion Worker：消费 Ingress，隔离坏消息到 Quarantine（BE-IOT-02）
    const ingestion = mkFunction('IngestionFn', 'ingestion', {
      timeout: Duration.seconds(60),
      environment: {
        DB_SECRET_ARN: dbSecret,
        QUARANTINE_QUEUE_URL: messaging.quarantine.queueUrl,
      },
    });
    ingestion.addEventSource(
      new lambdaEventSources.SqsEventSource(messaging.ingress, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );
    messaging.quarantine.grantSendMessages(ingestion);
    dbSecretGrant(ingestion);

    // Archive Worker：消费 Archive，写 Raw Bucket（BE-ARC-02）
    const archive = mkFunction('ArchiveFn', 'archive', {
      timeout: Duration.seconds(300),
      environment: { RAW_BUCKET_NAME: storage.raw.bucketName },
    });
    archive.addEventSource(
      new lambdaEventSources.SqsEventSource(messaging.archive, {
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(30),
        reportBatchItemFailures: true,
      }),
    );
    storage.raw.grantWrite(archive);

    // Outbox Publisher：事务性 Outbox → Archive SQS（BE-ARC-01）
    const outboxPublisher = mkFunction('OutboxPublisherFn', 'outbox-publisher', {
      timeout: Duration.seconds(60),
      environment: {
        DB_SECRET_ARN: dbSecret,
        ARCHIVE_QUEUE_URL: messaging.archive.queueUrl,
      },
    });
    messaging.archive.grantSendMessages(outboxPublisher);
    dbSecretGrant(outboxPublisher);
    new events.Rule(this, 'OutboxPublisherSchedule', {
      ruleName: this.naming.name('outbox-publisher'),
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(outboxPublisher)],
    });

    // Summary Worker：小时/日聚合（BE-ESG-01）
    const summary = mkFunction('SummaryFn', 'summary', {
      timeout: Duration.seconds(300),
      environment: { DB_SECRET_ARN: dbSecret },
    });
    dbSecretGrant(summary);
    new events.Rule(this, 'SummarySchedule', {
      ruleName: this.naming.name('summary'),
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(summary)],
    });

    // SEC-01：主动销毁到期密文包，避免仅在领取请求时被动清理
    const certPackageSweeper = mkFunction('CertPackageSweeperFn', 'cert-package-sweeper', {
      timeout: Duration.seconds(300),
      environment: { DB_SECRET_ARN: dbSecret },
    });
    dbSecretGrant(certPackageSweeper);
    new events.Rule(this, 'CertPackageSweeperSchedule', {
      ruleName: this.naming.name('cert-package-sweeper'),
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(certPackageSweeper)],
    });

    // API Handler：Onboarding / Device / Admin / Customer / Internal 五个分组的统一计算载体
    const apiRole = new iam.Role(this, 'ApiFnServiceRole', {
      roleName: this.naming.name(API_ROLE_SUFFIX),
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'API Lambda execution role and sole certificate-package KMS data-plane principal',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    const api = mkFunction('ApiFn', 'api', {
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        DB_SECRET_ARN: dbSecret,
        USER_POOL_ID: identity.userPool.userPoolId,
        USER_POOL_CLIENT_ID: identity.userPoolClient.userPoolClientId,
        RAW_BUCKET_NAME: storage.raw.bucketName,
        OTA_BUCKET_NAME: storage.ota.bucketName,
        MEDIA_BUCKET_NAME: storage.media.bucketName,
        EXPORT_BUCKET_NAME: storage.exportBucket.bucketName,
        CERT_PACKAGE_KEY_ARN: storage.certPackageKey.keyArn,
      },
      role: apiRole,
    });
    dbSecretGrant(api);
    // 预签名 URL 与重放读取：仅授予业务所需 Bucket 的对象级读写
    storage.media.grantReadWrite(api);
    storage.ota.grantReadWrite(api);
    storage.exportBucket.grantReadWrite(api);
    storage.raw.grantRead(api);
    // SEC-01：证书包信封加密 Key 的加解密权限仅此角色持有
    apiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'CertificatePackageKeyDataPlane',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [storage.certPackageKey.keyArn],
      }),
    );
    // 下行发布（BE-CMD-02/BE-OTA-03）：仅允许 3 个下行 Topic 模式
    api.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IotDownlinkPublish',
        actions: ['iot:Publish'],
        resources: DOWNLINK_TOPIC_TYPES.map((type) =>
          this.formatArn({ service: 'iot', resource: 'topic', resourceName: `bnx/device/*/${type}` }),
        ),
      }),
    );
    // 设备发放（BE-ONB-03）：CreateKeysAndCertificate 等动作不支持资源级收敛，保持动作级白名单
    api.addToRolePolicy(
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
        ],
        resources: ['*'],
      }),
    );

    return { ingestion, archive, outboxPublisher, summary, certPackageSweeper, api };
  }

  // ---------- API Gateway：三类认证入口分离 ----------

  private createApiGateways(apiFn: lambda.IFunction, identity: IdentityResources, truststore: s3.Bucket): ApiResources {
    const integration = new apigw.LambdaIntegration(apiFn, { proxy: true });
    const stageOptions: apigw.StageOptions = { stageName: this.config.envName };

    // 入口 1：Onboarding API —— 一次性 Token（应用层校验，AUTH-02），不带 mTLS/Cognito
    const onboardingApi = new apigw.RestApi(this, 'OnboardingApi', {
      restApiName: this.naming.name('onboarding-api'),
      description: 'Onboarding API：一次性 Token 认证（AUTH-02），独立于 mTLS 入口',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { ...stageOptions, throttlingRateLimit: 20, throttlingBurstLimit: 40 },
    });
    onboardingApi.root
      .addResource('api')
      .addResource('v1')
      .addResource('device')
      .addProxy({ defaultIntegration: integration, anyMethod: true });

    // 入口 2：Device API —— X.509 mTLS（自定义域名 truststore）；提供域名配置后禁用默认入口
    const deviceApi = new apigw.RestApi(this, 'DeviceApi', {
      restApiName: this.naming.name('device-api'),
      description: 'Device API：X.509 mTLS 自定义域名入口（AUTH-03 应用层白名单）',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      disableExecuteApiEndpoint: this.config.allowInsecureDeviceEndpointForLocal !== true,
      deployOptions: stageOptions,
    });
    deviceApi.root
      .addResource('api')
      .addResource('v1')
      .addResource('device')
      .addProxy({ defaultIntegration: integration, anyMethod: true });

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
        mtls: { bucket: truststore, key: deviceApiDomain.truststoreKey },
      });
      domain.addBasePathMapping(deviceApi, { stage: deviceApi.deploymentStage });
    }

    // 入口 3：Admin API —— Cognito JWT（/admin、/customer）与 IAM（/internal，仅限云端任务）
    const adminApi = new apigw.RestApi(this, 'AdminApi', {
      restApiName: this.naming.name('admin-api'),
      description: 'Admin/Customer/Internal API：Cognito JWT + IAM（AUTH-01）',
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
    v1.addResource('admin').addProxy({ defaultIntegration: integration, defaultMethodOptions: cognitoMethodOptions });
    v1.addResource('customer').addProxy({
      defaultIntegration: integration,
      defaultMethodOptions: cognitoMethodOptions,
    });
    v1.addResource('internal').addProxy({
      defaultIntegration: integration,
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
    });

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
    output('OnboardingApiUrl', apis.onboardingApi.url, 'Onboarding API 入口（Token）');
    output('DeviceApiUrl', apis.deviceApi.url, 'Device API 入口（mTLS 自定义域名映射目标）');
    output('AdminApiUrl', apis.adminApi.url, 'Admin/Customer/Internal API 入口（Cognito/IAM）');
    output('UserPoolId', identity.userPool.userPoolId, 'Cognito User Pool');
    output('UserPoolClientId', identity.userPoolClient.userPoolClientId, 'Cognito Admin Web Client');
    output('DbSecretArn', data.dbSecretArn, 'RDS 凭据 Secret（Secrets Manager）');
    output('DbEndpointAddress', data.db.instanceEndpoint.hostname, 'RDS 连接地址');
    output('IngressQueueUrl', messaging.ingress.queueUrl, 'Ingress SQS');
    output('ArchiveQueueUrl', messaging.archive.queueUrl, 'Archive SQS');
    output('QuarantineQueueUrl', messaging.quarantine.queueUrl, 'Quarantine SQS');
    output('RuleErrorQueueUrl', messaging.ruleError.queueUrl, 'IoT Rule Error SQS');
    output('RawBucketName', storage.raw.bucketName, 'S3 Raw 归档');
    output('OtaBucketName', storage.ota.bucketName, 'S3 OTA 包');
    output('MediaBucketName', storage.media.bucketName, 'S3 Media 文件');
    output('ExportBucketName', storage.exportBucket.bucketName, 'S3 导出文件');
    output('TruststoreBucketName', storage.truststore.bucketName, 'S3 mTLS truststore');
    output('DataKeyArn', storage.dataKey.keyArn, 'KMS 应用数据 Key');
    output('CertPackageKeyArn', storage.certPackageKey.keyArn, 'KMS 证书包信封加密 Key');
  }
}
