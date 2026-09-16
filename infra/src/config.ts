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
  readonly truststoreBucketName?: string;
  readonly truststoreVersion?: string;
}

export interface InfraConfig {
  /** 环境名，全部资源名前缀的一部分。 */
  readonly envName: string;
  readonly deviceApiDomain?: DeviceApiDomainConfig;
  /** 仅 local/test 可显式打开的无 mTLS execute-api 开发入口。 */
  readonly allowInsecureDeviceEndpointForLocal?: true;
  readonly businessEmailFrom?: string;
  readonly businessWebhookAllowedHosts?: readonly string[];
  readonly adminWebOrigin?: string;
  readonly enableMigrationRunner?: boolean;
  readonly deploymentAccount?: string;
  readonly deploymentRegion?: string;
  readonly adminApiDomain?: { readonly domainName: string; readonly certificateArn: string };
  readonly onboardingApiDomain?: { readonly domainName: string; readonly certificateArn: string };
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
  const truststoreBucketName = app.node.tryGetContext('deviceApiTruststoreBucketName') as string | undefined;
  const truststoreVersion = app.node.tryGetContext('deviceApiTruststoreVersion') as string | undefined;
  const adminWebOrigin = app.node.tryGetContext('adminWebOrigin') as string | undefined;
  if (adminWebOrigin) {
    const url = new URL(adminWebOrigin);
    if (
      url.origin !== adminWebOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    ) {
      throw new Error('adminWebOrigin 必须为精确 HTTPS Origin（本地回环允许 HTTP）');
    }
  }
  const enableMigrationRunner = ['true', true].includes(app.node.tryGetContext('enableMigrationRunner'));
  const deploymentAccount = app.node.tryGetContext('deploymentAccount') as string | undefined;
  const deploymentRegion = app.node.tryGetContext('deploymentRegion') as string | undefined;
  if (!!deploymentAccount !== !!deploymentRegion || (deploymentAccount && !/^\d{12}$/u.test(deploymentAccount))) {
    throw new Error('deploymentAccount（12 位）与 deploymentRegion 必须同时提供');
  }
  if (
    deploymentAccount &&
    (!domainName || !certificateArn || !truststoreBucketName || !truststoreVersion || !adminWebOrigin)
  ) {
    throw new Error('真实部署必须配置 mTLS 域名、证书、预置 truststore Bucket/Version 与 adminWebOrigin');
  }
  if (
    deploymentAccount &&
    !certificateArn?.startsWith(`arn:aws:acm:${deploymentRegion}:${deploymentAccount}:certificate/`)
  ) {
    throw new Error('Device API ACM 证书必须属于部署账号与区域');
  }
  if (deploymentAccount && ['true', true].includes(app.node.tryGetContext('allowInsecureDeviceEndpointForLocal'))) {
    throw new Error('真实部署禁止不安全 Device execute-api 入口');
  }
  const publicApiCertificateArn = app.node.tryGetContext('publicApiCertificateArn') as string | undefined;
  const adminApiDomainName = app.node.tryGetContext('adminApiDomainName') as string | undefined;
  const onboardingApiDomainName = app.node.tryGetContext('onboardingApiDomainName') as string | undefined;
  if ((adminApiDomainName || onboardingApiDomainName) && !publicApiCertificateArn) {
    throw new Error('公共 API 自定义域名必须配置 publicApiCertificateArn');
  }
  if (
    deploymentAccount &&
    publicApiCertificateArn &&
    !publicApiCertificateArn.startsWith(`arn:aws:acm:${deploymentRegion}:${deploymentAccount}:certificate/`)
  ) {
    throw new Error('公共 API ACM 证书必须属于部署账号与区域');
  }
  const deployment = {
    adminWebOrigin,
    enableMigrationRunner,
    deploymentAccount,
    deploymentRegion,
    ...(adminApiDomainName && publicApiCertificateArn
      ? { adminApiDomain: { domainName: adminApiDomainName, certificateArn: publicApiCertificateArn } }
      : {}),
    ...(onboardingApiDomainName && publicApiCertificateArn
      ? { onboardingApiDomain: { domainName: onboardingApiDomainName, certificateArn: publicApiCertificateArn } }
      : {}),
  };
  const allowInsecureDeviceEndpointForLocal = app.node.tryGetContext('allowInsecureDeviceEndpointForLocal') === true;
  const businessEmailFrom = app.node.tryGetContext('businessEmailFrom') as string | undefined;
  const webhookHosts = app.node.tryGetContext('businessWebhookAllowedHosts') as string | undefined;
  const businessWebhookAllowedHosts = webhookHosts
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!['local', 'test'].includes(envName) && (!businessEmailFrom || !businessWebhookAllowedHosts?.length)) {
    throw new Error('非 local/test 环境必须配置 businessEmailFrom 与 businessWebhookAllowedHosts');
  }

  if (domainName === undefined && certificateArn === undefined) {
    if (!allowInsecureDeviceEndpointForLocal || !['local', 'test'].includes(envName)) {
      throw new Error(
        'Device API 必须配置 mTLS 自定义域名；仅 local/test 可显式设置 allowInsecureDeviceEndpointForLocal=true',
      );
    }
    return {
      envName,
      ...deployment,
      allowInsecureDeviceEndpointForLocal: true,
      ...(businessEmailFrom ? { businessEmailFrom } : {}),
      ...(businessWebhookAllowedHosts?.length ? { businessWebhookAllowedHosts } : {}),
    };
  }
  if (domainName === undefined || certificateArn === undefined) {
    throw new Error('deviceApiDomainName 与 deviceApiCertificateArn 必须同时提供（mTLS 自定义域名成对出现）');
  }
  return {
    envName,
    ...deployment,
    deviceApiDomain: {
      domainName,
      certificateArn,
      truststoreKey: truststoreKey ?? 'truststore/ca-bundle.pem',
      truststoreBucketName,
      truststoreVersion,
    },
    ...(businessEmailFrom ? { businessEmailFrom } : {}),
    ...(businessWebhookAllowedHosts?.length ? { businessWebhookAllowedHosts } : {}),
  };
}
