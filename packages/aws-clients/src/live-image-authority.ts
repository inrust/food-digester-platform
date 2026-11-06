import { createRedactingLogger } from '@fdp/observability';
import {
  createPrismaClient,
  lockLiveImageAuthority,
  withLiveImageAuthorityWriters,
  withLiveImageIoLifetime,
} from '@fdp/database';
import type { PrismaClient, Prisma } from '@fdp/database';
import type { AuthorityMutation } from '@fdp/database';
import type { LiveImageControlStore, LiveImageControlVersion } from '@fdp/domain';
import { createLiveImageStoreFromEnv } from './live-image-dynamodb.js';

const fields: Record<string, readonly string[]> = {
  device: ['customerId', 'siteId', 'lifecycleStatus', 'customer', 'site', 'liveImagePolicy', 'certificates'],
  deviceLatestState: ['operationalStatus'],
  deviceCertificate: [
    'deviceId',
    'device',
    'fingerprint',
    'status',
    'revokedAt',
    'notBefore',
    'notAfter',
    'rotationDeadlineAt',
    'rotationConfirmedAt',
  ],
  user: ['status', 'cognitoSub', 'roles', 'scopes'],
};
const authorityModels = new Set([
  ...Object.keys(fields),
  'userRole',
  'userScope',
  'role',
  'customer',
  'site',
  'deviceLiveImagePolicy',
]);
const authorityRelations = new Set([
  'device',
  'devices',
  'user',
  'users',
  'roles',
  'scopes',
  'liveImagePolicy',
  'latestState',
  'certificates',
  'customer',
  'site',
]);
const nestedMutations = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'connect',
  'disconnect',
  'set',
]);
function hasNestedAuthorityWrite(args: readonly unknown[]): boolean {
  // Inspect Prisma write envelopes, never arbitrary JSON payload fields.
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value).some(
      ([key, child]) =>
        (authorityRelations.has(key) &&
          child &&
          typeof child === 'object' &&
          Object.keys(child).some((op) => nestedMutations.has(op))) ||
        ((nestedMutations.has(key) || key === 'data') && visit(child)),
    );
  };
  return args.some((arg) => {
    const root = arg as { data?: unknown; create?: unknown; update?: unknown } | undefined;
    return root && [root.data, root.create, root.update].some(visit);
  });
}
type DynamicDelegate = { findMany(args: unknown): Promise<Array<Record<string, unknown>>> };
async function affectsAuthority(tx: Prisma.TransactionClient, change: AuthorityMutation): Promise<boolean> {
  const { model, operation } = change;
  if (!model) {
    const sql = change.args[0];
    const text = (typeof sql === 'string' ? sql : '').replace(/\s+/g, ' ').trim();
    // These two exact, repository-owned counter statements cannot change preview authority.
    const counter =
      'INSERT INTO "auth_rate_limits" ("rate_key", "window_start", "count", "expires_at") VALUES ($1, $2, 1, $3) ON CONFLICT ("rate_key", "window_start") DO UPDATE SET "count" = "auth_rate_limits"."count" + 1, "expires_at" = GREATEST("auth_rate_limits"."expires_at", EXCLUDED."expires_at") RETURNING "count"';
    return text !== counter && text !== 'DELETE FROM "auth_rate_limits" WHERE "window_start" < $1';
  }
  if (!authorityModels.has(model)) return hasNestedAuthorityWrite(change.args);
  const keys = fields[model];
  if (!keys || operation.startsWith('delete') || operation.startsWith('create')) return true;
  const args = change.args[0] as {
    data?: Record<string, unknown>;
    update?: Record<string, unknown>;
    create?: Record<string, unknown>;
    where?: unknown;
  };
  const data = args.data ?? args.update ?? {};
  const changed = keys.filter((key) => Object.hasOwn(data, key) && data[key] !== undefined);
  if (!changed.length) return false;
  // Skip unchanged telemetry status, but nested/relation/operator writes fence conservatively.
  if (
    changed.some(
      (key) =>
        (typeof data[key] === 'object' && data[key] !== null) ||
        ['customer', 'site', 'roles', 'scopes', 'device', 'certificates', 'liveImagePolicy'].includes(key),
    )
  )
    return true;
  const rows = await (tx as unknown as Record<string, DynamicDelegate>)[model]!.findMany({
    where: args.where,
    select: Object.fromEntries(changed.map((key) => [key, true])),
  });
  if (!rows.length) return operation.startsWith('upsert');
  return rows.some((row) => changed.some((key) => row[key] !== data[key]));
}
async function affectedPolicies(tx: Prisma.TransactionClient, change: AuthorityMutation, store: LiveImageControlStore) {
  const args = change.args[0] as { where?: unknown; data?: unknown; create?: unknown; update?: unknown } | undefined;
  const data = [args?.data, args?.create, args?.update].flatMap((v) => (Array.isArray(v) ? v : v ? [v] : [])) as Array<
    Record<string, unknown>
  >;
  const rows = async (model: string, keys: string[]) =>
    change.operation.startsWith('create')
      ? []
      : (tx as unknown as Record<string, DynamicDelegate>)[model]!.findMany({
          where: args?.where,
          select: Object.fromEntries(keys.map((key) => [key, true])),
        });
  const values = (records: Array<Record<string, unknown>>, key: string) =>
    records.map((row) => row[key]).filter((id): id is string => typeof id === 'string');
  let deviceIds: string[] | undefined;
  let actorIds: Set<string> | undefined;
  if (['device', 'deviceLatestState', 'deviceCertificate', 'deviceLiveImagePolicy'].includes(change.model)) {
    const idKey = change.model === 'device' ? 'id' : 'deviceId';
    const records = [...(await rows(change.model, [idKey])), ...data];
    deviceIds = [...new Set(values(records, idKey))];
  } else if (['customer', 'site'].includes(change.model)) {
    const ids = values(await rows(change.model, ['id']), 'id');
    deviceIds = (
      await tx.device.findMany({
        where: change.model === 'customer' ? { customerId: { in: ids } } : { siteId: { in: ids } },
        select: { id: true },
      })
    ).map((d) => d.id);
  } else if (['user', 'userRole', 'userScope'].includes(change.model)) {
    const idKey = change.model === 'user' ? 'id' : 'userId';
    const records = [...(await rows(change.model, [idKey])), ...data];
    const ids = values(records, idKey);
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { cognitoSub: true } });
    actorIds = new Set([
      ...users.map((u) => u.cognitoSub).filter((id): id is string => !!id),
      ...values(data, 'cognitoSub'),
    ]);
  }
  const devices = await tx.device.findMany({
    where: { liveImagePolicy: { isNot: null }, ...(deviceIds ? { id: { in: deviceIds } } : {}) },
    select: { id: true, customerId: true },
    orderBy: { id: 'asc' },
  });
  if (!actorIds) return devices;
  const affected = [];
  for (const device of devices) {
    const control = await store.readControl(device.id);
    if (control?.viewers.some((v) => actorIds!.has(v.actorId))) affected.push(device);
  }
  return affected;
}
export async function fenceLiveImageControl(
  store: LiveImageControlStore,
  deviceId: string,
  customerId: string | null,
  enabled: boolean,
): Promise<{ wasEnabled: boolean; version: LiveImageControlVersion }> {
  for (let n = 0; n < 5; n++) {
    const current = await store.readControl(deviceId);
    const wasEnabled = current?.enabled ?? false;
    const next = {
      deviceId,
      customerId,
      enabled,
      revision: (current?.revision ?? 0) + 1,
      authEpoch: (current?.authEpoch ?? 0) + 1,
      streamId: null,
      viewers: [],
      latestCapturedAtMs: null,
      lastNewFrameAtMs: current?.lastNewFrameAtMs ?? null,
    };
    if (await store.compareAndSwap(deviceId, current, next)) return { wasEnabled, version: next };
  }
  throw new Error('LIVE_IMAGE_FENCE_CONFLICT');
}
function eligible(device: {
  customerId: string | null;
  lifecycleStatus: string;
  latestState: { operationalStatus: string | null } | null;
  liveImagePolicy: { enabled: boolean } | null;
}) {
  return (
    !!device.customerId &&
    !!device.liveImagePolicy?.enabled &&
    ['Active', 'Maintenance'].includes(device.lifecycleStatus) &&
    ['Active', 'Maintenance'].includes(device.latestState?.operationalStatus ?? '')
  );
}

/** Every Lambda DB composition root uses this wrapper. No implicit reopening after rollback. */
export function withLiveImageAuthority(client: PrismaClient, store: LiveImageControlStore): PrismaClient {
  const state = new WeakMap<object, { reset: Map<string, LiveImageControlVersion>; scheduled: boolean }>();
  return withLiveImageAuthorityWriters(client, {
    async beforeMutation(tx, change) {
      if (change.model && !authorityModels.has(change.model) && !hasNestedAuthorityWrite(change.args)) return;
      await lockLiveImageAuthority(tx, 'write');
      if (!(await affectsAuthority(tx, change))) return;
      const existing = state.get(tx) ?? { reset: new Map<string, LiveImageControlVersion>(), scheduled: false };
      state.set(tx, existing);
      // Fence affected devices only. User/scope edits invalidate streams containing that actor;
      // unclassified raw/nested writes conservatively invalidate the allowlisted population.
      const devices = await affectedPolicies(tx, change, store);
      for (const device of devices) {
        await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', device.id);
        const fence = await fenceLiveImageControl(store, device.id, device.customerId, false);
        if (fence.wasEnabled || existing.reset.has(device.id)) existing.reset.set(device.id, fence.version);
      }
      // Allowlist mutations are the explicit enable/recover command; update only this transaction's policy IDs.
      if (change.model === 'deviceLiveImagePolicy') {
        const args = change.args[0] as {
          where?: { deviceId?: string };
          create?: { deviceId?: string };
          data?: { deviceId?: string };
        };
        const id = args.where?.deviceId ?? args.create?.deviceId ?? args.data?.deviceId;
        if (id) {
          await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', id);
          const device = await tx.device.findUnique({ where: { id }, select: { customerId: true } });
          const fence = await fenceLiveImageControl(store, id, device?.customerId ?? null, false);
          existing.reset.set(id, fence.version);
        }
      }
      if (existing.scheduled) return;
      existing.scheduled = true;
      return async () => {
        try {
          await withLiveImageIoLifetime(() =>
            client.$transaction(
              async (fresh) => {
                await lockLiveImageAuthority(fresh, 'write');
                for (const [id, token] of existing.reset) {
                  const control = await store.readControl(id);
                  // A later fence, including one whose SQL rolled back, must never be reopened here.
                  if (
                    !control ||
                    control.revision !== token.revision ||
                    control.authEpoch !== token.authEpoch ||
                    control.enabled
                  )
                    throw new Error('LIVE_IMAGE_AUTHORITY_RECHECK_REQUIRED');
                  const device = await fresh.device.findUnique({
                    where: { id },
                    include: { latestState: true, liveImagePolicy: true },
                  });
                  await fenceLiveImageControl(store, id, device?.customerId ?? null, device ? eligible(device) : false);
                }
              },
              { timeout: 10000, maxWait: 1000 },
            ),
          );
        } catch {
          // The authoritative SQL already committed. Preserve its successful response, keep
          // preview closed and emit a fixed recovery signal (no SQL, payload or raw errors).
          createRedactingLogger(console).warn('live-image.authority.recheck-required');
        }
      };
    },
  });
}
export function withLiveImageAuthorityFromEnv(
  client: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): PrismaClient {
  if (!env.LIVE_IMAGE_CONTROL_TABLE && !env.LIVE_IMAGE_PAYLOAD_TABLE) return client; // Legacy/test composition roots, preview routes are unavailable.
  return withLiveImageAuthority(client, createLiveImageStoreFromEnv(env));
}
export function createPreviewAwarePrismaClient(databaseUrl: string): PrismaClient {
  return withLiveImageAuthorityFromEnv(createPrismaClient(databaseUrl));
}
