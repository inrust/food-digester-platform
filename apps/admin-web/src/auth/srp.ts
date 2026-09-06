/**
 * FE-01 Cognito SRP-6a 客户端数学（USER_SRP_AUTH，IAC-01 池客户端仅启用 userSrp）。
 *
 * 纯 BigInt 实现，无外部依赖；算法与 amazon-cognito-identity-js / pycognito 对齐：
 * - padHex：偶数化 + 最高位置位时前缀 '00'（防补码负数歧义）；
 * - k = H('00' || N || '0' || g)；u = H(pad(A) || pad(B))；x = H(pad(salt) || H(poolName || userIdForSrp || ':' || password))；
 * - S = (B - k·g^x)^(a + u·x) mod N；HKDF(prk=HMAC(pad(u), pad(S)), info='Caldera Derived Key'||0x01) 前 16 字节；
 * - 签名 = base64(HMAC(hkdf, poolName || userIdForSrp || base64decode(secretBlock) || timestamp))。
 *
 * 私钥 a 仅在内存持有，绝不持久化或进日志。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Cognito 固定的 3072-bit 群模数（RFC 3526 群变体，amazon-cognito-identity-js 内置常量）。 */
export const SRP_N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7' +
  'EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24' +
  'CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E' +
  '36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D22618' +
  '98FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F' +
  '85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F' +
  '2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFF' +
  'FFFFFFFFFFFFFF';

export class SrpError extends Error {
  readonly code: 'invalid-hex' | 'invalid-pool-id' | 'invalid-server-ephemeral' | 'invalid-scrambling-parameter';

  constructor(code: SrpError['code'], message: string) {
    super(message);
    this.name = 'SrpError';
    this.code = code;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) {
    throw new SrpError('invalid-hex', 'Expected an even-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Cognito 十六进制规整规则：奇数长度前缀 '0'；最高位置位（首字符 8-F）前缀 '00'。 */
export function padHex(hex: string): string {
  let out = hex;
  if (out.length % 2 === 1) {
    out = `0${out}`;
  } else if ('89ABCDEFabcdef'.includes(out[0] ?? '')) {
    out = `00${out}`;
  }
  return out;
}

function hexHash(hex: string): string {
  return sha256Hex(hexToBytes(hex));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

const N = BigInt(`0x${SRP_N_HEX}`);
const G = 2n;
const K = BigInt(`0x${hexHash(`00${SRP_N_HEX}0${'2'}`)}`);

export interface SrpEphemeral {
  /** 客户端私钥 a（hex），仅内存持有。 */
  readonly aHex: string;
  /** 客户端公钥 A（hex），随 InitiateAuth 的 SRP_A 发送。 */
  readonly srpAHex: string;
}

/** 生成 SRP 临时密钥对（a 为 128 字节随机数 mod N，与参考实现一致）。 */
export function generateSrpEphemeral(random: (byteLength: number) => Uint8Array = (n) => randomBytes(n)): SrpEphemeral {
  let a = BigInt(`0x${bytesToHex(random(128))}`) % N;
  if (a === 0n) a = 1n;
  const bigA = modPow(G, a, N);
  return { aHex: a.toString(16), srpAHex: bigA.toString(16) };
}

/** Cognito 用户池名 = UserPoolId 下划线后的部分（如 ap-east-1_abcdef → abcdef）。 */
export function userPoolNameOf(userPoolId: string): string {
  const separator = userPoolId.indexOf('_');
  if (separator <= 0 || separator === userPoolId.length - 1) {
    throw new SrpError('invalid-pool-id', 'UserPoolId must look like <region>_<name>');
  }
  return userPoolId.slice(separator + 1);
}

export interface PasswordVerifierInput {
  readonly userPoolId: string;
  /** Challenge 返回的 USER_ID_FOR_SRP（别名登录时与登录名不同，必须用它计算）。 */
  readonly userIdForSrp: string;
  readonly password: string;
  readonly saltHex: string;
  readonly srpBHex: string;
  readonly secretBlockBase64: string;
  readonly now?: () => Date;
}

export interface PasswordVerifierClaim {
  readonly timestamp: string;
  readonly passwordClaimSignature: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Cognito 时间戳格式：`Mon Sep 6 12:34:56 UTC 2026`（UTC，日不补零；签名覆盖客户端提供的原样字符串）。 */
export function formatCognitoTimestamp(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ` +
    `${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:${p2(date.getUTCSeconds())} UTC ${date.getUTCFullYear()}`
  );
}

/** 计算 PASSWORD_VERIFIER 应答（TIMESTAMP 与 PASSWORD_CLAIM_SIGNATURE）。 */
export function computePasswordVerifierClaim(
  ephemeral: SrpEphemeral,
  input: PasswordVerifierInput,
): PasswordVerifierClaim {
  const poolName = userPoolNameOf(input.userPoolId);
  const bigB = BigInt(`0x${input.srpBHex}`);
  if (bigB % N === 0n) {
    throw new SrpError('invalid-server-ephemeral', 'Server ephemeral B must not be 0 mod N');
  }
  const bigA = BigInt(`0x${ephemeral.srpAHex}`);
  const a = BigInt(`0x${ephemeral.aHex}`);

  const u = BigInt(`0x${hexHash(padHex(bigA.toString(16)) + padHex(bigB.toString(16)))}`);
  if (u === 0n) {
    throw new SrpError('invalid-scrambling-parameter', 'Scrambling parameter u must not be zero');
  }

  const usernamePasswordHash = sha256Hex(
    new TextEncoder().encode(`${poolName}${input.userIdForSrp}:${input.password}`),
  );
  const x = BigInt(`0x${hexHash(padHex(input.saltHex) + usernamePasswordHash)}`);

  const gPowX = modPow(G, x, N);
  const base = (((bigB - ((K * gPowX) % N)) % N) + N) % N;
  const sharedSecret = modPow(base, a + u * x, N);

  const prk = createHmac('sha256', hexToBytes(padHex(u.toString(16))))
    .update(hexToBytes(padHex(sharedSecret.toString(16))))
    .digest();
  const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
  const hkdfKey = createHmac('sha256', prk).update(info).digest().subarray(0, 16);

  const timestamp = formatCognitoTimestamp(input.now?.() ?? new Date());
  const message = Buffer.concat([
    Buffer.from(`${poolName}${input.userIdForSrp}`, 'utf8'),
    Buffer.from(input.secretBlockBase64, 'base64'),
    Buffer.from(timestamp, 'utf8'),
  ]);
  const signature = createHmac('sha256', hkdfKey).update(message).digest('base64');
  return { timestamp, passwordClaimSignature: signature };
}
