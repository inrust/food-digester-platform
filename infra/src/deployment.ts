import { DefaultStackSynthesizer, PermissionsBoundary } from 'aws-cdk-lib';
import type { InfraConfig } from './config.js';

export const FDP_BOOTSTRAP_QUALIFIER = 'fdptest01' as const;
export const FDP_SERVICE_BOUNDARY_NAME = 'FDP-ServiceBoundary' as const;

function requireDeploymentTarget(config: InfraConfig): { account: string; region: string } {
  if (!config.deploymentAccount || !config.deploymentRegion) {
    throw new Error('自定义部署 Synthesizer 仅用于已绑定账号与区域的真实部署');
  }
  return { account: config.deploymentAccount, region: config.deploymentRegion };
}

export function deploymentRoleName(envName: string, suffix: string): string {
  return `fdp-${envName}-${suffix}`;
}

export function createDeploymentSynthesizer(config: InfraConfig): DefaultStackSynthesizer {
  const { account, region } = requireDeploymentTarget(config);
  const roleArn = (suffix: string): string =>
    `arn:aws:iam::${account}:role/${deploymentRoleName(config.envName, suffix)}`;
  return new DefaultStackSynthesizer({
    qualifier: FDP_BOOTSTRAP_QUALIFIER,
    deployRoleArn: roleArn('cdk-deploy-role'),
    cloudFormationExecutionRole: roleArn('cloudformation-execution-role'),
    fileAssetPublishingRoleArn: roleArn('cdk-file-publishing-role'),
    imageAssetPublishingRoleArn: roleArn('cdk-image-publishing-role'),
    lookupRoleArn: roleArn('cdk-lookup-role'),
    fileAssetsBucketName: `fdp-${config.envName}-cdk-assets-${account}-${region}`,
    imageAssetsRepositoryName: `fdp-${config.envName}-cdk-assets-${account}-${region}`,
    bootstrapStackVersionSsmParameter: `/cdk-bootstrap/${FDP_BOOTSTRAP_QUALIFIER}/version`,
  });
}

export function serviceRoleBoundary(): PermissionsBoundary {
  return PermissionsBoundary.fromName(FDP_SERVICE_BOUNDARY_NAME);
}
