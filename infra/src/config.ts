/**
 * IAC-01 环境配置解析。
 *
 * 配置来源为 CDK context（`cdk synth -c envName=dev ...`），不读取真实凭据；
 * Device API 的 mTLS 自定义域名为可选配置，缺省时只创建 REGIONAL 默认入口，
 * 便于离线 synth 与开发环境先行验证。
 */
import type { App } from 'aws-cdk-lib';

/** Device API mTLS 自定义域名配置（三项必须同时提供）。 */
export interface DeviceApiDomainConfig {
  /** 如 device-api.example.com。 */
  readonly domainName: string;
  /** 域名对应 ACM 证书 ARN（REGIONAL，与 Stack 同区域）。 */
  readonly certificateArn: string;
  /** mTLS truststore CA bundle 在本 Stack truststore Bucket 中的 Key。 */
  readonly truststoreKey: string;
}

export interface InfraConfig {
  /** 环境名，全部资源名前缀的一部分。 */
  readonly envName: string;
  readonly deviceApiDomain?: DeviceApiDomainConfig;
}

export const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,14}$/;

export function validateEnvName(envName: string): string {
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(
      `非法环境名 "${envName}"：必须匹配 ${ENV_NAME_PATTERN.source}（小写字母开头，仅小写字母/数字/连字符）`,
    );
  }
  return envName;
}

/** 从 CDK App context 解析配置；非法组合立即失败。 */
export function resolveConfig(app: App): InfraConfig {
  const envName = validateEnvName(String(app.node.tryGetContext('envName') ?? 'dev'));

  const domainName = app.node.tryGetContext('deviceApiDomainName') as string | undefined;
  const certificateArn = app.node.tryGetContext('deviceApiCertificateArn') as string | undefined;
  const truststoreKey = app.node.tryGetContext('deviceApiTruststoreKey') as string | undefined;

  if (domainName === undefined && certificateArn === undefined) {
    return { envName };
  }
  if (domainName === undefined || certificateArn === undefined) {
    throw new Error('deviceApiDomainName 与 deviceApiCertificateArn 必须同时提供（mTLS 自定义域名成对出现）');
  }
  return {
    envName,
    deviceApiDomain: { domainName, certificateArn, truststoreKey: truststoreKey ?? 'truststore/ca-bundle.pem' },
  };
}
