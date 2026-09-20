import { CfnOutput, CustomResource, Duration, Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { FDP_MIGRATION_RUNNER_BOUNDARY_NAME } from '../deployment.js';

export interface MigrationExecutionStackProps extends StackProps {
  readonly sourceVersion: string;
  readonly sourceCommit: string;
}

const PROJECT_NAME = 'fdp-test-migration-runner' as const;

const HANDLER = String.raw`
const https = require('https');
const { CodeBuildClient, StartBuildCommand } = require('@aws-sdk/client-codebuild');

function respond(event, context, status, data, physicalResourceId) {
  const body = JSON.stringify({
    Status: status,
    Reason: status === 'FAILED' ? 'Migration build dispatch failed; inspect Lambda logs' : undefined,
    PhysicalResourceId: physicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data || {},
  });
  const target = new URL(event.ResponseURL);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'PUT',
      headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('error', reject);
    request.end(body);
  });
}

exports.handler = async (event, context) => {
  let physicalResourceId = event.PhysicalResourceId;
  try {
    if (event.RequestType === 'Create') {
      const { ProjectName, SourceVersion, SourceCommit } = event.ResourceProperties;
      if (ProjectName !== '${PROJECT_NAME}' || !SourceVersion || !/^[a-f0-9]{40}$/.test(SourceCommit)) {
        throw new Error('Invalid migration execution parameters');
      }
      const result = await new CodeBuildClient({}).send(new StartBuildCommand({
        projectName: ProjectName,
        sourceVersion: SourceVersion,
        environmentVariablesOverride: [
          { name: 'FDP_EXPECTED_SOURCE_COMMIT', value: SourceCommit, type: 'PLAINTEXT' },
        ],
      }));
      physicalResourceId = result.build.id;
      await respond(event, context, 'SUCCESS', { BuildId: result.build.id }, physicalResourceId);
      return;
    }
    await respond(event, context, 'SUCCESS', {}, physicalResourceId);
  } catch {
    await respond(event, context, 'FAILED', {}, physicalResourceId);
  }
};
`;

export class MigrationExecutionStack extends Stack {
  constructor(scope: Construct, id: string, props: MigrationExecutionStackProps) {
    super(scope, id, props);
    if (!props.sourceVersion || !/^[a-f0-9]{40}$/u.test(props.sourceCommit)) {
      throw new Error('Migration execution requires an S3 VersionId and exact 40-character source commit');
    }
    const role = new iam.Role(this, 'TriggerRole', {
      roleName: 'fdp-test-migration-trigger-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    iam.PermissionsBoundary.of(role).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        'MigrationRunnerBoundary',
        FDP_MIGRATION_RUNNER_BOUNDARY_NAME,
      ),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [`arn:${Stack.of(this).partition}:codebuild:${this.region}:${this.account}:project/${PROJECT_NAME}`],
      }),
    );
    const trigger = new lambda.Function(this, 'Trigger', {
      functionName: 'fdp-test-migration-trigger',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(HANDLER),
      timeout: Duration.minutes(1),
      role,
    });
    const execution = new CustomResource(this, 'Execution', {
      serviceToken: trigger.functionArn,
      properties: {
        ProjectName: PROJECT_NAME,
        SourceVersion: props.sourceVersion,
        SourceCommit: props.sourceCommit,
      },
    });
    new CfnOutput(this, 'BuildId', { value: execution.getAttString('BuildId') });
    Tags.of(this).add('fdp:project', 'food-digester-platform');
    Tags.of(this).add('fdp:env', 'test');
    Tags.of(this).add('fdp:managed-by', 'cdk');
  }
}
