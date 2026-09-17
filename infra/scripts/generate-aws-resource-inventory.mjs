import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppDependenciesStack } from '../dist/stacks/app-dependencies-stack.js';
import { createDeploymentSynthesizer, serviceRoleBoundary } from '../dist/deployment.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/generate-aws-resource-inventory.mjs <output.json>');
const config = {
  envName: 'test',
  deploymentAccount: '065986019555',
  deploymentRegion: 'ap-southeast-1',
  deviceApiDomain: {
    domainName: 'device-api.bio-nexa.com',
    certificateArn: 'arn:aws:acm:ap-southeast-1:065986019555:certificate/REVIEW_ONLY',
    truststoreKey: 'truststore/ca-bundle.pem',
    truststoreBucketName: 'REVIEW_ONLY',
    truststoreVersion: 'REVIEW_ONLY',
  },
  adminApiDomain: {
    domainName: 'api.bio-nexa.com',
    certificateArn: 'arn:aws:acm:ap-southeast-1:065986019555:certificate/REVIEW_ONLY',
  },
  onboardingApiDomain: {
    domainName: 'onboard-api.bio-nexa.com',
    certificateArn: 'arn:aws:acm:ap-southeast-1:065986019555:certificate/REVIEW_ONLY',
  },
  adminWebOrigin: 'https://admin.bio-nexa.com',
  enableMigrationRunner: true,
  enableScheduledWorkers: false,
  enableBusinessNotifications: false,
};
const app = new App();
const stack = new AppDependenciesStack(app, 'Inventory', {
  config,
  env: { account: config.deploymentAccount, region: config.deploymentRegion },
  synthesizer: createDeploymentSynthesizer(config),
  permissionsBoundary: serviceRoleBoundary(),
});
const template = Template.fromStack(stack).toJSON();
const counts = {};
for (const resource of Object.values(template.Resources)) counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(
  output,
  `${JSON.stringify({ reviewOnly: true, notDeployable: true, baseCommit, includesWorkingTreeChanges: true, counts }, null, 2)}\n`,
);
