/**
 * BE-DUSR-02 设备本地密码验证值生成器（KDF adapter / DTO / 脱敏管线）。
 *
 * DEC-004 约束（contracts/security/device-user-verifier-policy，当前 provisional）：
 * - 验证值设备本地专用，禁止复用 Cognito/云端用户密码 Hash；不赋予云端登录权限；
 * - 材料结构固定四字段 version+kdf+salt+hash；每用户独立随机 salt（不同 salt 结果必须不同）；
 * - 仅经 Unified Device Sync 的 Device Users 域下发（BE-SYNC-01 已落地）；查询 API/日志/审计脱敏；
 * - KDF 具体格式（算法/参数/salt/hash 长度）为待冻结参数，读取失败关闭——因此本模块把
 *   策略查询与 KDF 计算都设计为注入点：组合根必须经 contracts/security/
 *   device-user-verifier-policy.ts 的查询函数接线（cloud-api 不经 tsc 构建引用 contracts
 *   源码包；禁止直接读 JSON 或复制暂定值）。冻结前任何生成调用因策略参数不可得而失败关闭；
 *   冻结后仅需注入冻结的 adapter 与策略查询，管线与 DTO 不变。
 *
 * 功能边界：不实现设备端登录；明文密码仅存在于生成管线内存中，永不落库/日志/审计。
 */
import { randomBytes as cryptoRandomBytes } from 'node:crypto';

// ---------- 错误 ----------

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

// ---------- 注入点：策略查询门面与 KDF adapter ----------

/**
 * DEC-004 策略查询门面（镜像 contracts/security/device-user-verifier-policy.ts 的冻结参数
 * 查询函数签名）。组合根按该模块接线；provisional 期间各调用抛 PolicyParameterPendingError，
 * 本生成器不捕获、不兜底（失败关闭透传）。
 */
export interface VerifierPolicyQuery {
  /** KDF 算法标识（冻结前抛 PolicyParameterPendingError）。 */
  readonly getVerifierKdf: () => string;
  /** KDF 参数（迭代次数/内存等；冻结前抛 PolicyParameterPendingError）。 */
  readonly getVerifierKdfParameters: () => Readonly<Record<string, number | string>>;
  /** salt 长度（字节；冻结前抛 PolicyParameterPendingError）。 */
  readonly getVerifierSaltBytes: () => number;
  /** hash 输出长度（字节；冻结前抛 PolicyParameterPendingError）。 */
  readonly getVerifierHashBytes: () => number;
}

/** KDF adapter：冻结后由具体算法实现（如 PBKDF2/scrypt/Argon2 适配器）。 */
export interface VerifierKdfAdapter {
  /** 算法标识；必须等于策略 material.kdf，否则拒绝生成（防接线错配）。 */
  readonly kdfId: string;
  /** 验证材料版本（version 字段，支持算法迁移；随算法/参数升级递增）。 */
  readonly materialVersion: string;
  /** 派生设备本地验证值；实现方不得持久化明文密码。 */
  readonly derive: (input: {
    readonly password: string;
    readonly salt: Buffer;
    readonly parameters: Readonly<Record<string, number | string>>;
    readonly hashBytes: number;
  }) => Buffer;
}

// ---------- DTO ----------

/**
 * 生成的验证材料（DEC-004 固定四字段 version+kdf+salt+hash；salt/hash 为 base64）。
 * 与 BE-SYNC-01 Sync DTO（DeviceUserVerifierMaterial）字段一一对应；仅允许经 Sync 域下发。
 */
export interface GeneratedVerifierMaterial {
  readonly version: string;
  readonly kdf: string;
  readonly salt: string;
  readonly hash: string;
}

/** DEC-004 材料字段集合（与策略 material.fields 一致；顺序固定）。 */
export const VERIFIER_MATERIAL_FIELDS = ['version', 'kdf', 'salt', 'hash'] as const;

// ---------- 生成器 ----------

export interface VerifierGeneratorDeps {
  readonly policy: VerifierPolicyQuery;
  readonly adapter: VerifierKdfAdapter;
  /** CSPRNG（默认 node:crypto randomBytes；测试可注入固定值复现管线语义）。 */
  readonly randomBytes?: (bytes: number) => Buffer;
}

const MAX_PASSWORD_LENGTH = 1024;

/**
 * 生成设备本地专用验证材料。
 * 流程：明文密码校验 → 策略参数（冻结前失败关闭）→ adapter/策略一致性校验 →
 * CSPRNG 独立 salt → adapter 派生 → base64 四字段 DTO。
 * 明文密码不出本函数作用域；返回值不含密码。
 */
export function generateVerifierMaterial(deps: VerifierGeneratorDeps, password: string): GeneratedVerifierMaterial {
  if (typeof password !== 'string' || password.length === 0 || password.trim().length === 0) {
    throw new VerifierError('VALIDATION_FAILED', 'The password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new VerifierError('VALIDATION_FAILED', `The password must not exceed ${MAX_PASSWORD_LENGTH} characters`);
  }

  // 策略参数读取：provisional 期间抛 PolicyParameterPendingError（失败关闭，不兜底）
  const kdf = deps.policy.getVerifierKdf();
  const parameters = deps.policy.getVerifierKdfParameters();
  const saltBytes = deps.policy.getVerifierSaltBytes();
  const hashBytes = deps.policy.getVerifierHashBytes();

  if (deps.adapter.kdfId !== kdf) {
    throw new VerifierError(
      'CONFLICT',
      `The KDF adapter (${deps.adapter.kdfId}) does not match the verifier policy (${kdf})`,
    );
  }

  const randomBytes = deps.randomBytes ?? ((bytes: number) => cryptoRandomBytes(bytes));
  const salt = randomBytes(saltBytes);
  if (salt.length !== saltBytes) {
    throw new VerifierError('CONFLICT', `The salt source returned ${salt.length} bytes, expected ${saltBytes}`);
  }
  const hash = deps.adapter.derive({ password, salt, parameters, hashBytes });
  if (hash.length !== hashBytes) {
    throw new VerifierError('CONFLICT', `The KDF adapter returned ${hash.length} bytes, expected ${hashBytes}`);
  }

  return {
    version: deps.adapter.materialVersion,
    kdf,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

// ---------- 脱敏管线 ----------

/** 脱敏占位符（日志/审计中出现即表示已脱敏）。 */
export const VERIFIER_REDACTED = '[REDACTED]' as const;

/** 参与脱敏比对的最短 secret 长度（短于此不具定位意义，避免误伤普通文本）。 */
const MIN_SECRET_LENGTH = 8;

function collectSecrets(secrets: readonly (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      secrets
        .filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length),
    ),
  ];
}

/**
 * 日志/审计脱敏：把文本中出现的验证材料（hash/salt/明文密码，base64 或原文）替换为
 * [REDACTED]。用于写日志/审计前的最后防线（首要防线是 DTO 不含材料，BE-DUSR-01 已保证）。
 */
export function redactVerifierSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of collectSecrets(secrets)) {
    out = out.split(secret).join(VERIFIER_REDACTED);
  }
  return out;
}

/**
 * 泄漏断言：文本含任一验证材料即抛 VALIDATION_FAILED（用于审计/日志管线的 fail-fast 检查）。
 */
export function assertNoVerifierLeak(text: string, secrets: readonly (string | null | undefined)[]): void {
  for (const secret of collectSecrets(secrets)) {
    if (text.includes(secret)) {
      throw new VerifierError('VALIDATION_FAILED', 'The payload contains verifier material; redact before logging');
    }
  }
}
