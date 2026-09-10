export interface AdminWebRuntimeConfig {
  readonly apiBaseUrl: string;
  readonly cognitoRegion: string;
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId: string;
}

export class RuntimeConfigError extends Error {
  constructor(readonly missingKeys: readonly string[]) {
    super(`管理后台缺少必需运行时配置：${missingKeys.join(', ')}`);
    this.name = 'RuntimeConfigError';
  }
}

const REQUIRED_KEYS = [
  'VITE_ADMIN_API_BASE_URL',
  'VITE_COGNITO_REGION',
  'VITE_COGNITO_USER_POOL_ID',
  'VITE_COGNITO_CLIENT_ID',
] as const;

export function loadRuntimeConfig(env: Record<string, unknown>): AdminWebRuntimeConfig {
  const values = Object.fromEntries(
    REQUIRED_KEYS.map((key) => [key, typeof env[key] === 'string' ? env[key].trim() : '']),
  ) as Record<(typeof REQUIRED_KEYS)[number], string>;
  const missing = REQUIRED_KEYS.filter((key) => values[key] === '');
  if (missing.length > 0) throw new RuntimeConfigError(missing);

  return {
    apiBaseUrl: values.VITE_ADMIN_API_BASE_URL.replace(/\/$/, ''),
    cognitoRegion: values.VITE_COGNITO_REGION,
    cognitoUserPoolId: values.VITE_COGNITO_USER_POOL_ID,
    cognitoClientId: values.VITE_COGNITO_CLIENT_ID,
  };
}
