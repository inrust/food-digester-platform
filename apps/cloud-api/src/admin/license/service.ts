/**
 * BE-LIC-01 License/Entitlement 领域服务。
 *
 * 事实源与规则：
 * - 状态迁移走 DOM-02（transitionLicense/renewLicense/evaluateLicenseAt/createLicenseDraft），
 *   非法跳转/越权/缺原因由领域层抛 LicenseStateError；
 * - 一个设备不能出现两个有效 License：领域层 ctx.noOtherValidLicense + DB 部分唯一索引兜底
 *   （并发 P2002 → 409 CONFLICT）；
 * - 每次真实状态变化恰好产生：一条 license_history + 一次审计（DOM-02 auditEvent action）+
 *   一个 LICENSE_CHANGED Notification（Outbox 下行）+ 一个 DEC-016 DOMAIN_EVENT 归档；
 *   renew 同目标重放不写；
 * - License 签名字段供 Sync：Issue/Renew 时以注入签名密钥对规范载荷计算 HMAC-SHA256
 *   （base64url），Draft 无签名；签名机制由 DEC-020 冻结，密钥由 Secrets Manager/KMS 注入；
 * - 并发：licenses.version 条件更新（版本漂移 → 409）；
 * - 时间派生不实现定时扫描：evaluateLicense(licenseId, at) 可测试服务方法（SYSTEM actor：
 *   Active→ExpiringSoon/Expired、ExpiringSoon→Expired、Renewed→Active 结算）；activate 端点
 *   以 SYSTEM actor 执行 Issued→Active（要求已到 validFrom）。
 *
 * 功能边界：Entitlement 在创建 Draft 时配置（REST/签名为 REMOTE_CONTROL/OTA/ESG_REPORTING，
 * 历史 DB 码 OTA_UPDATE 仅在本服务边界映射）；
 * 不提供运行中 License 的 Entitlement 变更（需新任务定义迁移语义）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import {
  createLicenseDraft,
  evaluateLicenseAt,
  isLicenseEffective,
  renewLicense,
  transitionLicense,
} from '@fdp/domain';
import type { EntitlementCode, LicenseSnapshot, LicenseStatus, LicenseTransitionEffects } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { licenseConflict, licenseNotFound, licenseStateNotAllowed, licenseValidationFailed } from './errors.js';

export const LICENSE_CHANGED_NOTIFICATION = 'LICENSE_CHANGED' as const;
/** 创建 Draft 的阻断集合：设备存在任一非终态 License 时不可再建（含 Draft，避免草稿堆积）。 */
export const BLOCKING_LICENSE_STATUSES = ['Draft', 'Issued', 'Active', 'ExpiringSoon', 'Renewed'] as const;

/** 源契约 wire code 与历史内部存储码的唯一边界映射。 */
export function entitlementToWire(code: string): string {
  return code === 'OTA_UPDATE' ? 'OTA' : code;
}

export function entitlementFromWire(code: string): string {
  return code === 'OTA' ? 'OTA_UPDATE' : code;
}

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface LicenseDeps {
  readonly client: DbClient;
  /** DEC-020：License HMAC-SHA256 密钥，仅由部署层 Secret 注入。 */
  readonly signingKey: string;
  readonly now?: () => Date;
}

export interface EntitlementView {
  readonly code: string;
  readonly enabled: boolean;
}

export interface LicenseView {
  readonly licenseId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly entitlements: readonly EntitlementView[];
  /** 供 Device Sync 下发的签名（Draft 为 null）。 */
  readonly signature: string | null;
  readonly version: number;
  /** 查询时点派生：是否有效（可支撑设备运行，DOM-02 isLicenseEffective）。 */
  readonly effective: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LicenseSignaturePayload {
  readonly licenseId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly entitlements: readonly string[];
}

export interface LicenseHistoryView {
  readonly historyId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

interface LicenseRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly status: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly signature: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly entitlements: readonly { code: string; enabled: boolean }[];
}

interface LicenseDelegate {
  findFirst(args: Record<string, unknown>): Promise<LicenseRow | null>;
  findMany(args: Record<string, unknown>): Promise<LicenseRow[]>;
  create(args: Record<string, unknown>): Promise<LicenseRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

export interface LicenseListFilter {
  readonly customerId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly status?: string | undefined;
  readonly keyword?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

/** 正式 License 实体列表：保留终态历史记录，不再以 Device 当前授权摘要代替。 */
export async function listLicenses(
  deps: LicenseDeps,
  actor: ActorContext,
  filter: LicenseListFilter = {},
): Promise<Page<LicenseView>> {
  const statuses = ['Draft', 'Issued', 'Active', 'ExpiringSoon', 'Renewed', 'Expired', 'Revoked'];
  if (filter.status !== undefined && !statuses.includes(filter.status)) {
    throw licenseValidationFailed('status is not a supported License status');
  }
  const customerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : filter.customerId;
  const cursor = filter.cursor ? decodeKeysetCursor(filter.cursor) : null;
  const limit = normalizeLimit(filter.limit ?? null);
  const keyword = filter.keyword?.trim();
  const rows = await licenses(deps.client).findMany({
    where: {
      ...(customerId !== undefined ? { customerId } : {}),
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(keyword ? { OR: [{ id: { contains: keyword } }, { deviceId: { contains: keyword } }] } : {}),
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    include: { entitlements: true },
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => toView(row, deps.now?.() ?? new Date())),
    nextCursor: rows.length > limit && page.length > 0 ? encodeKeysetCursor(page[page.length - 1]!.id) : null,
  };
}

interface HistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<
    {
      id: string;
      fromStatus: string | null;
      toStatus: string;
      actorId: string | null;
      reason: string | null;
      createdAt: Date;
    }[]
  >;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function licenses(client: DbClient): LicenseDelegate {
  return (client as unknown as Record<string, unknown>).license as LicenseDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** DEC-020 License 规范载荷签名：固定字段顺序、UTC ISO 时间、wire entitlement 排序。 */
export function signLicensePayload(signingKey: string, payload: LicenseSignaturePayload): string {
  const canonical = JSON.stringify({
    licenseId: payload.licenseId,
    deviceId: payload.deviceId,
    customerId: payload.customerId,
    validFrom: payload.validFrom.toISOString(),
    validTo: payload.validTo.toISOString(),
    entitlements: payload.entitlements.map(entitlementToWire).sort(),
  });
  return `v1.${createHmac('sha256', signingKey).update(canonical).digest('base64url')}`;
}

function signatureMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** DEC-020 轮换验签：v1 同时尝试 active/previous；legacy 裸 MAC 只允许 previous key。 */
export function verifyLicensePayloadSignature(
  keys: { readonly active: string; readonly previous?: string },
  payload: LicenseSignaturePayload,
  signature: string,
): boolean {
  if (signature.startsWith('v1.')) {
    return [keys.active, keys.previous]
      .filter((key): key is string => typeof key === 'string')
      .some((key) => signatureMatches(signLicensePayload(key, payload), signature));
  }
  if (!keys.previous) return false;
  return signatureMatches(signLicensePayload(keys.previous, payload).slice('v1.'.length), signature);
}

function toSnapshot(row: LicenseRow): LicenseSnapshot {
  return {
    id: row.id,
    deviceId: row.deviceId,
    status: row.status as LicenseStatus,
    validFrom: row.validFrom,
    validTo: row.validTo,
    entitlements: row.entitlements.filter((e) => e.enabled).map((e) => e.code as EntitlementCode),
  };
}

function toView(row: LicenseRow, at: Date): LicenseView {
  return {
    licenseId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    status: row.status,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo.toISOString().slice(0, 10),
    entitlements: row.entitlements.map((e) => ({ code: entitlementToWire(e.code), enabled: e.enabled })),
    signature: row.signature,
    version: row.version,
    effective: isLicenseEffective(toSnapshot(row), at),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadLicense(client: DbClient, licenseId: string): Promise<LicenseRow> {
  const row = await licenses(client).findFirst({
    where: { id: licenseId },
    include: { entitlements: true },
  });
  if (!row) throw licenseNotFound();
  return row;
}

/** 在事务内应用 DOM-02 effects：条件更新 + 历史 + LICENSE_CHANGED Outbox（审计由 audited 包裹）。 */
async function applyTransition(
  tx: DbClient,
  effects: LicenseTransitionEffects,
  row: LicenseRow,
  data: Record<string, unknown>,
  occurredAt: Date,
): Promise<LicenseRow> {
  const { count } = await licenses(tx).updateMany({
    where: { id: row.id, version: row.version },
    data: { ...data, status: effects.to, version: { increment: 1 } },
  });
  if (count !== 1) throw licenseConflict('The license was changed concurrently; refresh and retry');

  const history = (tx as unknown as Record<string, unknown>).licenseHistory as HistoryDelegate;
  await history.create({
    data: {
      licenseId: effects.historyEntry.licenseId,
      fromStatus: effects.historyEntry.fromStatus,
      toStatus: effects.historyEntry.toStatus,
      actorId: effects.historyEntry.actorId,
      reason: effects.historyEntry.reason,
    },
  });

  const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  await outbox.create({
    data: {
      eventType: LICENSE_CHANGED_NOTIFICATION,
      aggregateType: 'license',
      aggregateId: row.id,
      payload: {
        topic: notificationTopic(row.deviceId),
        data: { type: LICENSE_CHANGED_NOTIFICATION, action: 'SYNC' },
        licenseId: row.id,
      },
    },
  });
  await outbox.create({
    data: {
      eventType: 'ARCHIVE',
      aggregateType: 'license',
      aggregateId: row.id,
      payload: {
        archiveClass: 'DOMAIN_EVENT',
        envelopeVersion: '1.0',
        entityType: 'license',
        domainEventType: 'LICENSE_STATUS_CHANGED',
        aggregateId: row.id,
        customerId: row.customerId,
        deviceId: row.deviceId,
        occurredAt: occurredAt.toISOString(),
        data: {
          licenseId: row.id,
          fromStatus: effects.historyEntry.fromStatus,
          toStatus: effects.historyEntry.toStatus,
          reason: effects.historyEntry.reason,
        },
      },
    },
  });

  const fresh = await licenses(tx).findFirst({ where: { id: row.id }, include: { entitlements: true } });
  if (!fresh) throw licenseNotFound();
  return fresh;
}

export interface CreateDraftInput {
  readonly deviceId: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly entitlements: readonly string[];
  readonly reason?: string | undefined;
}

/** 创建 Draft（license:write；设备须已分配 Customer 且未退役；无其他非终态 License）。 */
export async function createDraftLicense(
  deps: LicenseDeps,
  actor: ActorContext,
  input: CreateDraftInput,
): Promise<LicenseView> {
  const now = deps.now?.() ?? new Date();
  const deviceRow = await (
    (deps.client as unknown as Record<string, unknown>).device as {
      findFirst(args: { where: Record<string, unknown> }): Promise<{
        id: string;
        customerId: string | null;
        lifecycleStatus: string;
      } | null>;
    }
  ).findFirst({ where: { id: input.deviceId } });
  if (!deviceRow) throw licenseNotFound();
  if (!deviceRow.customerId) {
    throw licenseStateNotAllowed('The device is not assigned to a customer');
  }
  if (deviceRow.lifecycleStatus === 'Retired') {
    throw licenseStateNotAllowed('The device is retired');
  }

  const blocking = await licenses(deps.client).count({
    where: { deviceId: input.deviceId, status: { in: [...BLOCKING_LICENSE_STATUSES] } },
  });

  const entitlements = [...new Set(input.entitlements)] as EntitlementCode[];
  // 服务端生成 id（审计 objectId 需指向 license 本身）
  const licenseId = randomUUID();
  // DOM-02 领域校验（角色/有效期/Entitlement/唯一有效 License）
  const effects = createLicenseDraft(
    {
      id: licenseId,
      deviceId: input.deviceId,
      customerId: deviceRow.customerId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      entitlements,
      actor: {
        actorType: 'ADMIN',
        actorId: actor.actorId,
        actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
      },
    },
    { noOtherValidLicense: blocking === 0 },
  );
  void effects;

  try {
    return await audited<LicenseView>(
      deps.client,
      {
        objectType: 'license',
        objectId: licenseId,
        action: 'license.create_draft',
        reason: input.reason ?? null,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: deviceRow.customerId,
        afterValue: (result: unknown) => ({ licenseId: (result as LicenseView).licenseId, status: 'Draft' }),
      },
      async (tx) => {
        const row = await licenses(tx).create({
          data: {
            id: licenseId,
            deviceId: input.deviceId,
            customerId: deviceRow.customerId,
            status: 'Draft',
            validFrom: input.validFrom,
            validTo: input.validTo,
            createdBy: actor.actorId,
            entitlements: { create: entitlements.map((code) => ({ code, enabled: true })) },
          },
          include: { entitlements: true },
        });
        const history = (tx as unknown as Record<string, unknown>).licenseHistory as HistoryDelegate;
        await history.create({
          data: {
            licenseId: row.id,
            fromStatus: null,
            toStatus: 'Draft',
            actorId: actor.actorId,
            reason: input.reason ?? null,
          },
        });
        const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
        await outbox.create({
          data: {
            eventType: LICENSE_CHANGED_NOTIFICATION,
            aggregateType: 'license',
            aggregateId: row.id,
            payload: {
              topic: notificationTopic(row.deviceId),
              data: { type: LICENSE_CHANGED_NOTIFICATION, action: 'SYNC' },
              licenseId: row.id,
            },
          },
        });
        await outbox.create({
          data: {
            eventType: 'ARCHIVE',
            aggregateType: 'license',
            aggregateId: row.id,
            payload: {
              archiveClass: 'DOMAIN_EVENT',
              envelopeVersion: '1.0',
              entityType: 'license',
              domainEventType: 'LICENSE_STATUS_CHANGED',
              aggregateId: row.id,
              customerId: row.customerId,
              deviceId: row.deviceId,
              occurredAt: now.toISOString(),
              data: {
                licenseId: row.id,
                fromStatus: null,
                toStatus: 'Draft',
                reason: input.reason ?? null,
              },
            },
          },
        });
        return toView(row, now);
      },
    );
  } catch (err) {
    // 并发创建撞部分唯一索引 → 409（一个设备不能出现两个有效 License）
    if (isUniqueViolation(err)) {
      throw licenseConflict('The device already has a valid license');
    }
    throw err;
  }
}

interface TransitionOptions {
  readonly licenseId: string;
  readonly auditReason?: string | undefined;
}

async function runTransition(
  deps: LicenseDeps,
  actor: ActorContext,
  licenseId: string,
  compute: (
    row: LicenseRow,
    snapshot: LicenseSnapshot,
    now: Date,
  ) => { effects: LicenseTransitionEffects; data: Record<string, unknown> },
  auditCustomer: (row: LicenseRow) => string,
): Promise<LicenseView> {
  const now = deps.now?.() ?? new Date();
  const row = await loadLicense(deps.client, licenseId);
  const { effects, data } = compute(row, toSnapshot(row), now);
  return audited<LicenseView>(
    deps.client,
    {
      objectType: 'license',
      objectId: row.id,
      action: effects.auditEvent.action,
      reason: effects.auditEvent.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: auditCustomer(row),
      beforeValue: { status: row.status },
      afterValue: effects.auditEvent.afterValue as unknown as object,
    },
    async (tx) => toView(await applyTransition(tx, effects, row, data, now), now),
  );
}

/** Issue：Draft → Issued（生成签名）。 */
export async function issueLicense(
  deps: LicenseDeps,
  actor: ActorContext,
  options: TransitionOptions,
): Promise<LicenseView> {
  return runTransition(
    deps,
    actor,
    options.licenseId,
    (_row, snapshot, _now) => {
      const effects = transitionLicense(snapshot, 'Issued', {
        actorType: 'ADMIN',
        actorId: actor.actorId,
        actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
      });
      const signature = signLicensePayload(deps.signingKey, {
        licenseId: snapshot.id,
        deviceId: snapshot.deviceId,
        customerId: _row.customerId,
        validFrom: snapshot.validFrom,
        validTo: snapshot.validTo,
        entitlements: snapshot.entitlements,
      });
      return { effects, data: { signature } };
    },
    (row) => row.customerId,
  );
}

/** Activate：Issued → Active（SYSTEM actor 执行；要求已到 validFrom）。 */
export async function activateLicense(
  deps: LicenseDeps,
  actor: ActorContext,
  options: TransitionOptions,
): Promise<LicenseView> {
  return runTransition(
    deps,
    actor,
    options.licenseId,
    (_row, snapshot, now) => {
      if (snapshot.status === 'Issued' && now < snapshot.validFrom) {
        throw licenseStateNotAllowed('The license is not yet valid (validFrom is in the future)');
      }
      // DOM-02：Issued→Active 为 SYSTEM/DEVICE 迁移；管理端触发等价于系统激活事件
      const effects = transitionLicense(snapshot, 'Active', { actorType: 'SYSTEM', actorId: actor.actorId });
      return { effects, data: {} };
    },
    (row) => row.customerId,
  );
}

/** Renew：ExpiringSoon → Renewed（延长 validTo，重签）；同目标重复请求幂等回放。 */
export async function renewLicenseById(
  deps: LicenseDeps,
  actor: ActorContext,
  options: TransitionOptions & { readonly newValidTo: Date },
): Promise<LicenseView & { readonly replayed: boolean }> {
  const now = deps.now?.() ?? new Date();
  const row = await loadLicense(deps.client, options.licenseId);
  const effects = renewLicense(toSnapshot(row), options.newValidTo, {
    actorType: 'ADMIN',
    actorId: actor.actorId,
    actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
  });
  if (effects.idempotentReplay) {
    return { ...toView(row, now), replayed: true };
  }
  const signature = signLicensePayload(deps.signingKey, {
    licenseId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    validFrom: row.validFrom,
    validTo: options.newValidTo,
    entitlements: toSnapshot(row).entitlements,
  });
  const view = await audited<LicenseView>(
    deps.client,
    {
      objectType: 'license',
      objectId: row.id,
      action: effects.auditEvent.action,
      reason: effects.auditEvent.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: row.customerId,
      beforeValue: { status: row.status, validTo: row.validTo.toISOString() },
      afterValue: { status: 'Renewed', validTo: options.newValidTo.toISOString() },
    },
    async (tx) => toView(await applyTransition(tx, effects, row, { validTo: options.newValidTo, signature }, now), now),
  );
  return { ...view, replayed: false };
}

/** Revoke：Active/Expired → Revoked（强制原因）。 */
export async function revokeLicense(
  deps: LicenseDeps,
  actor: ActorContext,
  options: TransitionOptions,
): Promise<LicenseView> {
  const reason = options.auditReason?.trim();
  if (!reason) throw licenseValidationFailed('The reason is required to revoke a license');
  return runTransition(
    deps,
    actor,
    options.licenseId,
    (_row, snapshot, _now) => ({
      effects: transitionLicense(
        snapshot,
        'Revoked',
        {
          actorType: 'ADMIN',
          actorId: actor.actorId,
          actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
        },
        { reason },
      ),
      data: {},
    }),
    (row) => row.customerId,
  );
}

export interface EvaluateResult {
  readonly view: LicenseView;
  /** 是否发生时间派生/结算迁移（无变化时无写入/审计/通知）。 */
  readonly changed: boolean;
}

/**
 * 可测试的时间派生入口（不实现定时扫描，由调用方触发）：
 * Active→ExpiringSoon/Expired、ExpiringSoon→Expired（DOM-02 evaluateLicenseAt，SYSTEM）；
 * Renewed→Active 结算（SYSTEM，续期生效）。
 */
export async function evaluateLicense(
  deps: LicenseDeps,
  actor: ActorContext,
  licenseId: string,
  at: Date,
): Promise<EvaluateResult> {
  const row = await loadLicense(deps.client, licenseId);
  const snapshot = toSnapshot(row);

  let effects: LicenseTransitionEffects | null = null;
  if (snapshot.status === 'Renewed') {
    // 续期结算：Renewed → Active（SYSTEM）
    effects = transitionLicense(snapshot, 'Active', { actorType: 'SYSTEM', actorId: actor.actorId });
  } else {
    effects = evaluateLicenseAt(snapshot, at);
  }
  if (!effects) return { view: toView(row, at), changed: false };

  const view = await audited<LicenseView>(
    deps.client,
    {
      objectType: 'license',
      objectId: row.id,
      action: effects.auditEvent.action,
      reason: effects.auditEvent.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: row.customerId,
      beforeValue: { status: row.status },
      afterValue: effects.auditEvent.afterValue as unknown as object,
    },
    async (tx) => toView(await applyTransition(tx, effects as LicenseTransitionEffects, row, {}, at), at),
  );
  return { view, changed: true };
}

/** 详情（license:read）。 */
export async function getLicense(deps: LicenseDeps, licenseId: string): Promise<LicenseView> {
  const row = await loadLicense(deps.client, licenseId);
  return toView(row, deps.now?.() ?? new Date());
}

/** 历史（license:read；按 createdAt 倒序，上限 100）。 */
export async function listLicenseHistory(deps: LicenseDeps, licenseId: string): Promise<LicenseHistoryView[]> {
  await loadLicense(deps.client, licenseId); // 404 先行
  const history = (deps.client as unknown as Record<string, unknown>).licenseHistory as HistoryDelegate;
  const rows = await history.findMany({
    where: { licenseId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return rows.map((r) => ({
    historyId: r.id,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    actorId: r.actorId,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}
