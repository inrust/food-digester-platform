/**
 * IAC-01 环境配置解析。
 *
 * 配置来源为 CDK context（`cdk synth -c envName=dev ...`），不读取真实凭据；
 * Device API 默认强制 mTLS 自定义域名并禁用 execute-api；只有 local/test 显式开启
 * allowInsecureDeviceEndpointForLocal 时才可为离线开发保留默认入口。
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
  /** 仅 local/test 可显式打开的无 mTLS execute-api 开发入口。 */
  readonly allowInsecureDeviceEndpointForLocal?: true;
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
  const allowInsecureDeviceEndpointForLocal = app.node.tryGetContext('allowInsecureDeviceEndpointForLocal') === true;

  if (domainName === undefined && certificateArn === undefined) {
    if (!allowInsecureDeviceEndpointForLocal || !['local', 'test'].includes(envName)) {
      throw new Error(
        'Device API 必须配置 mTLS 自定义域名；仅 local/test 可显式设置 allowInsecureDeviceEndpointForLocal=true',
      );
    }
    return { envName, allowInsecureDeviceEndpointForLocal: true };
  }
  if (domainName === undefined || certificateArn === undefined) {
    throw new Error('deviceApiDomainName 与 deviceApiCertificateArn 必须同时提供（mTLS 自定义域名成对出现）');
  }
  return {
    envName,
    deviceApiDomain: { domainName, certificateArn, truststoreKey: truststoreKey ?? 'truststore/ca-bundle.pem' },
  };
}
