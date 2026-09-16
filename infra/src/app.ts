#!/usr/bin/env node
/**
 * IAC-01 CDK App 入口。
 *
 * 用法：
 *   pnpm --filter @fdp/infra synth                                  # dev 环境（默认）
 *   pnpm --filter @fdp/infra exec cdk synth -c envName=staging      # 指定环境
 *   # Device API mTLS 自定义域名（三项必须同时提供）：
 *   pnpm --filter @fdp/infra exec cdk synth -c envName=prod \
 *     -c deviceApiDomainName=device-api.example.com \
 *     -c deviceApiCertificateArn=arn:aws:acm:... \
 *     -c deviceApiTruststoreKey=truststore/ca-bundle.pem
 *
 * 说明：synth 不执行 AWS 调用，不需要任何云凭据；部署动作不在本任务范围。
 */
import { App } from 'aws-cdk-lib';
import { resolveConfig } from './config.js';
import { AppDependenciesStack } from './stacks/app-dependencies-stack.js';

const app = new App();
const config = resolveConfig(app);

new AppDependenciesStack(app, 'AppDependencies', {
  config,
  ...(config.deploymentAccount ? { env: { account: config.deploymentAccount, region: config.deploymentRegion } } : {}),
});

app.synth();
