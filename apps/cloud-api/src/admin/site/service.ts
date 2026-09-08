/**
 * BE-CUS-02 Site 管理 Service（业务核心，框架无关）。
 *
 * 规则：
 * - Site 必须属于唯一 Customer：创建时校验 Customer 存在且未删除（错误 Customer → 404），
 *   customerId 创建后不可变（更新请求携带 customerId → 400）；
 * - 时区使用 IANA 标识（Intl 校验，非法 → 400）；
 * - 全部写操作强制 If-Match 乐观锁并经 DOM-03 写审计；
 * - 停用强制原因（ACTIVE→SUSPENDED，重复停用 409）；
 * - 删除为软删除（V1 不做物理删除），有关联设备时 409 CONFLICT 明确错误。
 */
import type { DbClient } from '@fdp/database';
import { audited, recordAudit, withTransaction } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  siteAlreadySuspended,
  siteCustomerNotFound,
  siteDeleteConstrained,
  siteNotFound,
  siteValidationFailed,
} from './errors.js';
import { countSiteDevices, createSiteRecord, findSiteById, updateSiteWithVersion } from './repository.js';
import type { SiteRecord } from './repository.js';
import { parseStrictObject } from '../shared/strict-object.js';

const NAME_MAX = 200;
const FIELD_MAX = 200;
const ADDRESS_MAX = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 名称校验：非空字符串，去首尾空白后 1~200 字符。 */
export function parseSiteName(value: unknown): string {
  if (typeof value !== 'string') throw siteValidationFailed('name is required and must be a string');
  const name = value.trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    throw siteValidationFailed(`name must be 1~${NAME_MAX} characters after trimming`);
  }
  return name;
}

/** IANA 时区校验（Intl 内建 tz 数据库）。 */
export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseTimezone(value: unknown): string {
  if (value === undefined || value === null) return 'UTC';
  if (typeof value !== 'string' || !isValidIanaTimezone(value.trim())) {
    throw siteValidationFailed('timezone must be a valid IANA time zone identifier');
  }
  return value.trim();
}

/** 可空字符串字段：undefined=未提供；null/空白 → null；其余 trim 后限长。 */
function parseOptionalString(value: unknown, field: string, max: number = FIELD_MAX): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw siteValidationFailed(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw siteValidationFailed(`${field} must be at most ${max} characters`);
  return trimmed;
}

function parseContactEmail(value: unknown): string | null | undefined {
  const email = parseOptionalString(value, 'contactEmail');
  if (email && !EMAIL_PATTERN.test(email)) {
    throw siteValidationFailed('contactEmail must be a valid email address');
  }
  return email;
}

function auditActor(actor: ActorContext): { actorId: string; actorRole: string } {
  return { actorId: actor.actorId, actorRole: actor.roles[0] };
}

function auditSnapshot(record: SiteRecord): Record<string, unknown> {
  return {
    customerId: record.customerId,
    name: record.name,
    status: record.status,
    timezone: record.timezone,
    version: record.version,
  };
}

export interface SiteCreateInput {
  readonly customerId: string;
  readonly name: string;
  readonly region?: string | null | undefined;
  readonly subregion?: string | null | undefined;
  readonly address?: string | null | undefined;
  readonly timezone?: string | undefined;
  readonly contactName?: string | null | undefined;
  readonly contactPhone?: string | null | undefined;
  readonly contactEmail?: string | null | undefined;
}

/** 解析创建请求体（customerId 必填；错误 Customer 在事务外汇级校验前先拒绝）。 */
export function parseSiteCreate(body: unknown): SiteCreateInput {
  const input = parseStrictObject(
    body,
    ['customerId', 'name', 'region', 'subregion', 'address', 'timezone', 'contactName', 'contactPhone', 'contactEmail'],
    siteValidationFailed,
  );
  const customerId =
    typeof input.customerId === 'string' && input.customerId.trim().length > 0 ? input.customerId.trim() : null;
  if (!customerId) throw siteValidationFailed('customerId is required');
  return {
    customerId,
    name: parseSiteName(input.name),
    region: parseOptionalString(input.region, 'region') ?? null,
    subregion: parseOptionalString(input.subregion, 'subregion') ?? null,
    address: parseOptionalString(input.address, 'address', ADDRESS_MAX) ?? null,
    timezone: parseTimezone(input.timezone),
    contactName: parseOptionalString(input.contactName, 'contactName') ?? null,
    contactPhone: parseOptionalString(input.contactPhone, 'contactPhone') ?? null,
    contactEmail: parseContactEmail(input.contactEmail) ?? null,
  };
}

const UPDATABLE_FIELDS = [
  'name',
  'region',
  'subregion',
  'address',
  'timezone',
  'contactName',
  'contactPhone',
  'contactEmail',
] as const;

/** 解析更新请求体：仅允许 UPDATABLE_FIELDS；customerId 不可变；至少一个字段。 */
export function parseSiteUpdate(body: unknown): Record<string, unknown> {
  const input = parseStrictObject(body, UPDATABLE_FIELDS, siteValidationFailed);
  if ('customerId' in input) throw siteValidationFailed('customerId is immutable for a site');
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = parseSiteName(input.name);
  if (input.region !== undefined) patch.region = parseOptionalString(input.region, 'region');
  if (input.subregion !== undefined) patch.subregion = parseOptionalString(input.subregion, 'subregion');
  if (input.address !== undefined) patch.address = parseOptionalString(input.address, 'address', ADDRESS_MAX);
  if (input.timezone !== undefined) patch.timezone = parseTimezone(input.timezone);
  if (input.contactName !== undefined) patch.contactName = parseOptionalString(input.contactName, 'contactName');
  if (input.contactPhone !== undefined) patch.contactPhone = parseOptionalString(input.contactPhone, 'contactPhone');
  if (input.contactEmail !== undefined) patch.contactEmail = parseContactEmail(input.contactEmail);
  for (const key of Object.keys(input)) {
    if (!(UPDATABLE_FIELDS as readonly string[]).includes(key)) {
      throw siteValidationFailed(`unknown or immutable field: ${key}`);
    }
  }
  if (Object.keys(patch).length === 0) throw siteValidationFailed('at least one updatable field is required');
  return patch;
}

interface CustomerDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
}

/** 创建：Customer 存在且未删除（错误 Customer → 404）；业务写入与审计同一事务。 */
export async function createSite(
  rootClient: DbClient,
  actor: ActorContext,
  input: SiteCreateInput,
): Promise<SiteRecord> {
  return withTransaction(rootClient, async (tx) => {
    const customers = (tx as unknown as Record<string, unknown>).customer as CustomerDelegate;
    const customer = await customers.findFirst({ where: { id: input.customerId, deletedAt: null } });
    if (!customer) throw siteCustomerNotFound();
    const created = await createSiteRecord(tx, {
      customerId: input.customerId,
      name: input.name,
      status: 'ACTIVE',
      region: input.region ?? null,
      subregion: input.subregion ?? null,
      address: input.address ?? null,
      timezone: input.timezone ?? 'UTC',
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      contactEmail: input.contactEmail ?? null,
    });
    await recordAudit(tx, {
      objectType: 'site',
      objectId: created.id,
      action: 'site.create',
      result: 'SUCCESS',
      ...auditActor(actor),
      customerId: created.customerId,
      afterValue: auditSnapshot(created),
    });
    return created;
  });
}

export interface SiteWriteInput {
  readonly siteId: string;
  /** If-Match 版本（Handler 解析 Header 后传入）。 */
  readonly ifMatchVersion: number;
}

export async function updateSite(
  rootClient: DbClient,
  actor: ActorContext,
  input: SiteWriteInput & { patch: Record<string, unknown> },
): Promise<SiteRecord> {
  return audited<SiteRecord>(
    rootClient,
    {
      objectType: 'site',
      objectId: input.siteId,
      action: 'site.update',
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as SiteRecord),
    },
    async (tx) => {
      const current = await findSiteById(tx, input.siteId);
      if (!current) throw siteNotFound();
      return updateSiteWithVersion(tx, input.siteId, input.ifMatchVersion, input.patch);
    },
  );
}

export async function deactivateSite(
  rootClient: DbClient,
  actor: ActorContext,
  input: SiteWriteInput & { reason?: string | undefined },
): Promise<SiteRecord> {
  const reason = input.reason?.trim() || null;
  if (!reason) throw siteValidationFailed('The reason is required when deactivating a site');
  return audited<SiteRecord>(
    rootClient,
    {
      objectType: 'site',
      objectId: input.siteId,
      action: 'site.deactivate',
      reason,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as SiteRecord),
    },
    async (tx) => {
      const current = await findSiteById(tx, input.siteId);
      if (!current) throw siteNotFound();
      if (current.status !== 'ACTIVE') throw siteAlreadySuspended();
      return updateSiteWithVersion(tx, input.siteId, input.ifMatchVersion, { status: 'SUSPENDED' });
    },
  );
}

/** 软删除：有关联设备时返回明确的 409 错误；V1 不做物理删除。 */
export async function deleteSite(
  rootClient: DbClient,
  actor: ActorContext,
  input: SiteWriteInput,
): Promise<SiteRecord> {
  return audited<SiteRecord>(
    rootClient,
    {
      objectType: 'site',
      objectId: input.siteId,
      action: 'site.delete',
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => ({ ...auditSnapshot(result as SiteRecord), deleted: true }),
    },
    async (tx) => {
      const current = await findSiteById(tx, input.siteId);
      if (!current) throw siteNotFound();
      const deviceCount = await countSiteDevices(tx, input.siteId);
      if (deviceCount > 0) {
        throw siteDeleteConstrained(`The site has ${deviceCount} associated device(s) and cannot be deleted`);
      }
      return updateSiteWithVersion(tx, input.siteId, input.ifMatchVersion, { deletedAt: new Date() });
    },
  );
}
