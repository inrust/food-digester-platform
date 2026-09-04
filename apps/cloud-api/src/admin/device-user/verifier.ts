/**
 * BE-DUSR-02 设备本地密码验证值生成器。
 *
 * DEC-004@1.0.0 冻结值：Argon2id v=19、m=32768 KiB、t=3、p=1、
 * 16 字节独立 salt、32 字节 hash；线协议使用 passwordHash PHC 字符串。
 * 明文密码只在本模块调用栈内存在，不落库、不进响应、日志或审计。
 */
import { argon2id, hash, verify } from 'argon2';

export const DEVICE_USER_ARGON2_PARAMETERS = {
  type: argon2id,
  version: 0x13,
  memoryCost: 32_768,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export const DEVICE_USER_SALT_BYTES = 16 as const;
export const DEVICE_USER_PASSWORD_HASH_PATTERN = /^\$argon2id\$v=19\$m=32768,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

const MAX_PASSWORD_LENGTH = 1024;

export type VerifierErrorCode = 'VALIDATION_FAILED' | 'CONFLICT';

export const VERIFIER_ERROR_HTTP_STATUS: Readonly<Record<VerifierErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
} as const;

export class VerifierError extends Error {
  override readonly name = 'VerifierError';
  readonly code: VerifierErrorCode;

  constructor(code: VerifierErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return VERIFIER_ERROR_HTTP_STATUS[this.code];
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0 || password.trim().length === 0) {
    throw new VerifierError('VALIDATION_FAILED', 'The password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new VerifierError('VALIDATION_FAILED', `The password must not exceed ${MAX_PASSWORD_LENGTH} characters`);
  }
}

export function assertDeviceUserPasswordHash(passwordHash: string): void {
  if (!DEVICE_USER_PASSWORD_HASH_PATTERN.test(passwordHash)) {
    throw new VerifierError('CONFLICT', 'The password hash does not match DEC-004@1.0.0');
  }
}

/** 生成设备本地专用 PHC 字符串；salt 仅用于确定性跨设备测试向量。 */
export async function hashDeviceUserPassword(password: string, salt?: Buffer): Promise<string> {
  assertPassword(password);
  if (salt !== undefined && salt.length !== DEVICE_USER_SALT_BYTES) {
    throw new VerifierError('CONFLICT', `The salt must be ${DEVICE_USER_SALT_BYTES} bytes`);
  }
  const passwordHash = await hash(password, {
    ...DEVICE_USER_ARGON2_PARAMETERS,
    ...(salt !== undefined ? { salt } : {}),
  });
  assertDeviceUserPasswordHash(passwordHash);
  return passwordHash;
}

/** 设备侧等价复验路径；格式或密码错误统一返回 false，不泄露原因。 */
export async function verifyDeviceUserPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    assertDeviceUserPasswordHash(passwordHash);
    assertPassword(password);
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export const VERIFIER_REDACTED = '[REDACTED]' as const;
const MIN_SECRET_LENGTH = 8;

function collectSecrets(secrets: readonly (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      secrets
        .filter((value): value is string => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length),
    ),
  ];
}

export function redactVerifierSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of collectSecrets(secrets)) out = out.split(secret).join(VERIFIER_REDACTED);
  return out;
}

export function assertNoVerifierLeak(text: string, secrets: readonly (string | null | undefined)[]): void {
  for (const secret of collectSecrets(secrets)) {
    if (text.includes(secret)) {
      throw new VerifierError('VALIDATION_FAILED', 'The payload contains verifier material; redact before logging');
    }
  }
}
