/**
 * BE-OTA-01 Firmware Package 上传会话与上传后校验 Service（框架无关）。
 *
 * 规则：
 * - 创建上传会话（ota:write）：校验 model/version（Key 段字符集）/packageType
 *   （APP|FIRMWARE，与 CT-03 OTA Schema 一致）/sizeBytes（1~512MiB 暂定上限）/
 *   SHA-256（hex64）/签名（必填，格式由签名策略冻结值驱动）；同型号+版本+packageType
 *   唯一、sha256 唯一（先读后写 + P2002 并发兜底 → 409）；objectKey 服务端生成，
 *   返回短期预签名上传 URL（900s 暂定）；记录状态 UPLOADED；审计
 *   ota.package.upload_session.create（DOM-03）；
 * - 上传完成校验（complete，ota:write）：对象存在 → 大小一致 → SHA-256 重算匹配 →
 *   病毒扫描 adapter（未选型缺省不装配；INFECTED 拒绝）→ 数字签名验证（策略冻结值
 *   驱动，provisional 期间失败关闭 → 409；型号/版本错配即签名不匹配）→ 条件更新
 *   UPLOADED→VERIFIED（并发兜底）；审计 ota.package.verify；
 * - 不可变：VERIFIED 为终态（RETIRED 流转属 BE-OTA-02），重复完成 → 409，成功包
 *   不可覆盖；包内容字段（model/version/packageType/sha256/sizeBytes/s3Key/signature）
 *   创建后无任何更新路径；
 * - 可发布列表 = status VERIFIED；UPLOADED（未完成上传/未完成校验）不进入可发布列表；
 * - uploadedBy 取自身份上下文（actor.actorId），不信任客户端声明；
 * - 功能边界：不实现设备端验签、安装和回滚（BE-OTA-03 下发前的包源）。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { otaPackageConflict, otaPackageNotFound, otaSignaturePolicyPending, otaValidationFailed } from './errors.js';
import {
  FIRMWARE_KEY_SEGMENT_PATTERN,
  MAX_FIRMWARE_PACKAGE_SIZE_BYTES,
  OTA_UPLOAD_URL_TTL_SECONDS,
  buildFirmwareObjectKey,
} from './storage.js';
import type { OtaPackageStorage, OtaUploadUrlSigner } from './storage.js';
import { buildSignaturePayload, isPolicyParameterPending } from './signature.js';
import type { FirmwareSignatureVerifier, OtaSignaturePolicyQuery } from './signature.js';

/** 包类型（与 contracts/mqtt/schemas/ota.schema.json 枚举一致）。 */
export const FIRMWARE_PACKAGE_TYPES = ['APP', 'FIRMWARE'] as const;

/** 包状态机：UPLOADED → VERIFIED（不可变）；RETIRED 由 BE-OTA-02 管理。 */
export const FIRMWARE_PACKAGE_STATUSES = ['UPLOADED', 'VERIFIED', 'RETIRED'] as const;

const SHA256_PATTERN = /^[0-9A-Fa-f]{64}$/;

/** 病毒扫描 adapter 端口（未选型：缺省不装配，不留桩实现）。 */
export interface MalwareScanner {
  readonly scan: (input: { readonly key: string; readonly sha256: string }) => Promise<'CLEAN' | 'INFECTED'>;
}

export interface OtaPackageDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly storage: OtaPackageStorage;
  readonly uploadUrlSigner: OtaUploadUrlSigner;
  readonly signaturePolicy: OtaSignaturePolicyQuery;
  readonly signatureVerifier: FirmwareSignatureVerifier;
  /** 病毒扫描 adapter（未选型缺省 undefined，不执行扫描）。 */
  readonly malwareScanner?: MalwareScanner | undefined;
  readonly uploadUrlTtlSeconds?: number;
}

// ---------- 行类型与数据访问 ----------

interface FirmwarePackageRow {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly packageType: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
  readonly s3Key: string;
  readonly signature: string | null;
  readonly status: string;
  readonly uploadedBy: string;
  readonly createdAt: Date;
}

interface FirmwarePackageDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<FirmwarePackageRow | null>;
  findMany(args: Record<string, unknown>): Promise<FirmwarePackageRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<FirmwarePackageRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function firmwarePackages(client: DbClient): FirmwarePackageDelegate {
  return (client as unknown as Record<string, unknown>).firmwarePackage as FirmwarePackageDelegate;
}

// ---------- DTO ----------

export interface FirmwarePackageView {
  readonly packageId: string;
  readonly model: string;
  readonly version: string;
  readonly packageType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: string;
  readonly objectKey: string;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export interface FirmwareUploadSessionView {
  readonly packageId: string;
  readonly status: 'UPLOADED';
  readonly model: string;
  readonly version: string;
  readonly packageType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
  readonly createdAt: string;
}

function toView(row: FirmwarePackageRow): FirmwarePackageView {
  return {
    packageId: row.id,
    model: row.model,
    version: row.version,
    packageType: row.packageType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    status: row.status,
    objectKey: row.s3Key,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

// ---------- 创建上传会话 ----------

export interface CreateFirmwareUploadSessionInput {
  readonly model: string;
  readonly version: string;
  readonly packageType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** 对规范载荷（策略锁定字段）的数字签名；格式由项目冻结值驱动。 */
  readonly signature: string;
}

function validateSessionInput(input: CreateFirmwareUploadSessionInput): void {
  if (!FIRMWARE_KEY_SEGMENT_PATTERN.test(input.model)) {
    throw otaValidationFailed('model must match ^[A-Za-z0-9._-]{1,64}$');
  }
  if (!FIRMWARE_KEY_SEGMENT_PATTERN.test(input.version)) {
    throw otaValidationFailed('version must match ^[A-Za-z0-9._-]{1,64}$');
  }
  if (!(FIRMWARE_PACKAGE_TYPES as readonly string[]).includes(input.packageType)) {
    throw otaValidationFailed(`packageType must be one of: ${FIRMWARE_PACKAGE_TYPES.join(', ')}`);
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_FIRMWARE_PACKAGE_SIZE_BYTES) {
    throw otaValidationFailed(`sizeBytes must be an integer between 1 and ${MAX_FIRMWARE_PACKAGE_SIZE_BYTES}`);
  }
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw otaValidationFailed('sha256 must be a 64-character hex string');
  }
  if (typeof input.signature !== 'string' || input.signature.length === 0 || input.signature.length > 4096) {
    throw otaValidationFailed('signature is required and must not exceed 4096 characters');
  }
}

export async function createFirmwareUploadSession(
  deps: OtaPackageDeps,
  actor: ActorContext,
  input: CreateFirmwareUploadSessionInput,
): Promise<FirmwareUploadSessionView> {
  validateSessionInput(input);
  const now = deps.now?.() ?? new Date();
  const sha256 = input.sha256.toLowerCase();

  // 唯一性预检：同型号+版本+packageType / 同 sha256 → 409（并发由 P2002 兜底）
  const duplicate = await firmwarePackages(deps.client).findFirst({
    where: {
      OR: [{ model: input.model, version: input.version, packageType: input.packageType }, { sha256 }],
    },
  });
  if (duplicate) {
    throw otaPackageConflict(
      `A firmware package for model ${input.model} version ${input.version} packageType ${input.packageType} already exists`,
    );
  }

  const packageId = randomUUID();
  const objectKey = buildFirmwareObjectKey({
    model: input.model,
    packageType: input.packageType,
    version: input.version,
    packageId,
  });

  let row: FirmwarePackageRow;
  try {
    row = await audited<FirmwarePackageRow>(
      deps.client,
      {
        objectType: 'firmware_package',
        objectId: packageId,
        action: 'ota.package.upload_session.create',
        reason: `model=${input.model} version=${input.version} packageType=${input.packageType}`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: null,
        afterValue: () => ({
          packageId,
          model: input.model,
          version: input.version,
          packageType: input.packageType,
          sizeBytes: input.sizeBytes,
          sha256,
          status: 'UPLOADED',
        }),
      },
      (tx) =>
        firmwarePackages(tx).create({
          data: {
            id: packageId,
            model: input.model,
            version: input.version,
            packageType: input.packageType,
            sha256,
            sizeBytes: input.sizeBytes,
            s3Key: objectKey,
            signature: input.signature,
            status: 'UPLOADED',
            uploadedBy: actor.actorId,
            createdAt: now,
          },
        }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw otaPackageConflict(
        `A firmware package for model ${input.model} version ${input.version} packageType ${input.packageType} already exists`,
      );
    }
    throw err;
  }

  const ttl = deps.uploadUrlTtlSeconds ?? OTA_UPLOAD_URL_TTL_SECONDS;
  const uploadUrlExpiresAt = new Date(now.getTime() + ttl * 1000);
  const uploadUrl = deps.uploadUrlSigner.signUpload({ key: objectKey, expiresAt: uploadUrlExpiresAt });
  return {
    packageId: row.id,
    status: 'UPLOADED',
    model: row.model,
    version: row.version,
    packageType: row.packageType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    objectKey: row.s3Key,
    uploadUrl,
    uploadUrlExpiresAt: uploadUrlExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- 上传完成校验（UPLOADED → VERIFIED） ----------

/**
 * 验签：策略冻结值驱动（失败关闭）；型号/版本/packageType/sha256 进规范载荷，
 * 任一不匹配即签名不匹配。
 */
async function verifySignature(deps: OtaPackageDeps, row: FirmwarePackageRow): Promise<void> {
  if (!row.signature) {
    throw otaValidationFailed('The package has no declared signature');
  }
  let algorithm: string;
  let trustRoot: string;
  let encoding: string;
  let payloadFields: readonly string[];
  try {
    algorithm = deps.signaturePolicy.getSignatureAlgorithm();
    trustRoot = deps.signaturePolicy.getSignatureTrustRoot();
    encoding = deps.signaturePolicy.getSignatureEncoding();
    payloadFields = deps.signaturePolicy.getSignaturePayloadFields();
  } catch (err) {
    // 签名机制未冻结：失败关闭（不兜底、不降级为仅 Hash 校验）
    if (isPolicyParameterPending(err)) throw otaSignaturePolicyPending();
    throw err;
  }
  if (deps.signatureVerifier.algorithmId !== algorithm) {
    throw otaPackageConflict(
      `The signature verifier (${deps.signatureVerifier.algorithmId}) does not match the signature policy (${algorithm})`,
    );
  }
  let payload: string;
  try {
    payload = buildSignaturePayload(payloadFields, {
      model: row.model,
      version: row.version,
      packageType: row.packageType,
      sha256: row.sha256.toLowerCase(),
    });
  } catch {
    throw otaPackageConflict('The signature policy declares unknown payload fields');
  }
  const valid = await deps.signatureVerifier.verify({
    payload,
    signature: row.signature,
    trustRoot,
    encoding,
  });
  if (!valid) {
    throw otaValidationFailed('The package signature does not match the declared model/version/packageType/sha256');
  }
}

export async function completeFirmwareUpload(
  deps: OtaPackageDeps,
  actor: ActorContext,
  packageId: string,
): Promise<FirmwarePackageView> {
  const row = await firmwarePackages(deps.client).findFirst({ where: { id: packageId } });
  if (!row) throw otaPackageNotFound();
  // 成功包不可覆盖：VERIFIED/RETIRED 为不可再校验态，重复完成 → 409
  if (row.status !== 'UPLOADED') {
    throw otaPackageConflict(`The package is ${row.status}; verified packages are immutable`);
  }

  // 1. 对象存在 + 2. 大小一致
  const stat = await deps.storage.statObject(row.s3Key);
  if (!stat) {
    throw otaValidationFailed('The package object was not found; the upload is not completed');
  }
  if (stat.sizeBytes !== Number(row.sizeBytes)) {
    throw otaValidationFailed(
      `The package size mismatch: declared ${Number(row.sizeBytes)} bytes, actual ${stat.sizeBytes} bytes`,
    );
  }

  // 3. SHA-256 重算匹配
  const actualSha256 = await deps.storage.computeSha256(row.s3Key);
  if (!actualSha256) {
    throw otaValidationFailed('The package object was not found; the upload is not completed');
  }
  if (actualSha256.toLowerCase() !== row.sha256.toLowerCase()) {
    throw otaValidationFailed('The package SHA-256 mismatch');
  }

  // 4. 病毒扫描 adapter（未选型缺省不装配）
  if (deps.malwareScanner) {
    const verdict = await deps.malwareScanner.scan({ key: row.s3Key, sha256: row.sha256 });
    if (verdict !== 'CLEAN') {
      throw otaValidationFailed('The package was rejected by the malware scanner');
    }
  }

  // 5. 数字签名验证（策略冻结值驱动，失败关闭）
  await verifySignature(deps, row);

  // 6. 状态迁移（条件更新并发兜底：仅一个完成者获胜）+ 审计
  return audited<FirmwarePackageView>(
    deps.client,
    {
      objectType: 'firmware_package',
      objectId: row.id,
      action: 'ota.package.verify',
      reason: `model=${row.model} version=${row.version} packageType=${row.packageType}`,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: null,
      afterValue: (result: FirmwarePackageView) => ({
        packageId: result.packageId,
        status: result.status,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
      }),
    },
    async (tx) => {
      const claimed = await firmwarePackages(tx).updateMany({
        where: { id: row.id, status: 'UPLOADED' },
        data: { status: 'VERIFIED' },
      });
      if (claimed.count !== 1) {
        throw otaPackageConflict('The package was already verified; verified packages are immutable');
      }
      return { ...toView(row), status: 'VERIFIED' };
    },
  );
}

// ---------- 查询（可发布列表 = status VERIFIED） ----------

export interface ListFirmwarePackagesFilter {
  readonly model?: string | undefined;
  readonly version?: string | undefined;
  readonly packageType?: string | undefined;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export async function listFirmwarePackages(
  deps: OtaPackageDeps,
  filter: ListFirmwarePackagesFilter = {},
): Promise<Page<FirmwarePackageView>> {
  if (filter.packageType !== undefined && !(FIRMWARE_PACKAGE_TYPES as readonly string[]).includes(filter.packageType)) {
    throw otaValidationFailed(`packageType must be one of: ${FIRMWARE_PACKAGE_TYPES.join(', ')}`);
  }
  if (filter.status !== undefined && !(FIRMWARE_PACKAGE_STATUSES as readonly string[]).includes(filter.status)) {
    throw otaValidationFailed(`status must be one of: ${FIRMWARE_PACKAGE_STATUSES.join(', ')}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = {};
  if (filter.model) where.model = filter.model;
  if (filter.version) where.version = filter.version;
  if (filter.packageType) where.packageType = filter.packageType;
  if (filter.status) where.status = filter.status;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await firmwarePackages(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

export async function getFirmwarePackage(deps: OtaPackageDeps, packageId: string): Promise<FirmwarePackageView> {
  const row = await firmwarePackages(deps.client).findFirst({ where: { id: packageId } });
  if (!row) throw otaPackageNotFound();
  return toView(row);
}
