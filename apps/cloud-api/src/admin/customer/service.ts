/**
 * BE-CUS-01 Customer 管理 Service（业务核心，框架无关）。
 *
 * 全部写操作（create/update/deactivate/delete）经 DOM-03 audited：
 * 业务写入与 SUCCESS 审计同一事务提交；业务失败回滚后独立记 FAILURE。
 * 更新/停用/删除强制 If-Match 乐观锁（版本不符 → 409 VERSION_CONFLICT）；
 * 删除为软删除（V1 不做物理删除），存在关联有效设备/有效 License 时拒绝（409 CONFLICT）。
 */
import type { DbClient } from '@fdp/database';
import { audited, recordAudit, withTransaction } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { alreadySuspended, deleteConstrained, customerNotFound, validationFailed } from './errors.js';
import {
  countActiveDevices,
  countEffectiveLicenses,
  customers,
  findCustomerById,
  updateCustomerWithVersion,
} from './repository.js';
import type { CustomerRecord } from './repository.js';

export const CUSTOMER_NAME_MAX_LENGTH = 200;

/** 名称校验：非空字符串，去首尾空白后 1~200 字符。 */
export function parseCustomerName(value: unknown): string {
  if (typeof value !== 'string') throw validationFailed('name is required and must be a string');
  const name = value.trim();
  if (name.length === 0 || name.length > CUSTOMER_NAME_MAX_LENGTH) {
    throw validationFailed(`name must be 1~${CUSTOMER_NAME_MAX_LENGTH} characters after trimming`);
  }
  return name;
}

function auditActor(actor: ActorContext): { actorId: string; actorRole: string } {
  return { actorId: actor.actorId, actorRole: actor.roles[0] };
}

function auditSnapshot(record: CustomerRecord): Record<string, unknown> {
  return { name: record.name, status: record.status, version: record.version };
}

/** 创建：业务写入与审计同一事务（审计携带创建后的真实 customerId）。 */
export async function createCustomer(
  rootClient: DbClient,
  actor: ActorContext,
  input: { name: string },
): Promise<CustomerRecord> {
  return withTransaction(rootClient, async (tx) => {
    const created = await customers(tx).create({ data: { name: input.name, status: 'ACTIVE' } });
    await recordAudit(tx, {
      objectType: 'customer',
      objectId: created.id,
      action: 'customer.create',
      result: 'SUCCESS',
      ...auditActor(actor),
      customerId: created.id,
      afterValue: auditSnapshot(created),
    });
    return created;
  });
}

export interface CustomerWriteInput {
  readonly customerId: string;
  /** If-Match 版本（Handler 解析 Header 后传入）。 */
  readonly ifMatchVersion: number;
}

export async function updateCustomer(
  rootClient: DbClient,
  actor: ActorContext,
  input: CustomerWriteInput & { name: string },
): Promise<CustomerRecord> {
  return audited<CustomerRecord>(
    rootClient,
    {
      objectType: 'customer',
      objectId: input.customerId,
      action: 'customer.update',
      ...auditActor(actor),
      customerId: input.customerId,
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as CustomerRecord),
    },
    async (tx) => {
      const current = await findCustomerById(tx, input.customerId);
      if (!current) throw customerNotFound();
      return updateCustomerWithVersion(tx, input.customerId, input.ifMatchVersion, { name: input.name });
    },
  );
}

export async function deactivateCustomer(
  rootClient: DbClient,
  actor: ActorContext,
  input: CustomerWriteInput & { reason?: string | undefined },
): Promise<CustomerRecord> {
  const reason = input.reason?.trim() || null;
  if (!reason) throw validationFailed('The reason is required when deactivating a customer');
  return audited<CustomerRecord>(
    rootClient,
    {
      objectType: 'customer',
      objectId: input.customerId,
      action: 'customer.deactivate',
      reason,
      ...auditActor(actor),
      customerId: input.customerId,
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as CustomerRecord),
    },
    async (tx) => {
      const current = await findCustomerById(tx, input.customerId);
      if (!current) throw customerNotFound();
      if (current.status !== 'ACTIVE') throw alreadySuspended();
      return updateCustomerWithVersion(tx, input.customerId, input.ifMatchVersion, { status: 'SUSPENDED' });
    },
  );
}

/** 软删除：存在关联有效设备/有效 License 时返回明确的 409 错误；V1 不做物理删除。 */
export async function deleteCustomer(
  rootClient: DbClient,
  actor: ActorContext,
  input: CustomerWriteInput,
): Promise<CustomerRecord> {
  return audited<CustomerRecord>(
    rootClient,
    {
      objectType: 'customer',
      objectId: input.customerId,
      action: 'customer.delete',
      ...auditActor(actor),
      customerId: input.customerId,
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => ({ ...auditSnapshot(result as CustomerRecord), deleted: true }),
    },
    async (tx) => {
      const current = await findCustomerById(tx, input.customerId);
      if (!current) throw customerNotFound();
      const activeDevices = await countActiveDevices(tx, input.customerId);
      if (activeDevices > 0) {
        throw deleteConstrained(`The customer has ${activeDevices} associated active device(s) and cannot be deleted`);
      }
      const effectiveLicenses = await countEffectiveLicenses(tx, input.customerId);
      if (effectiveLicenses > 0) {
        throw deleteConstrained(
          `The customer has ${effectiveLicenses} associated effective license(s) and cannot be deleted`,
        );
      }
      return updateCustomerWithVersion(tx, input.customerId, input.ifMatchVersion, { deletedAt: new Date() });
    },
  );
}
