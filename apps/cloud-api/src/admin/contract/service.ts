/**
 * BE-CON-01 Contract CRUD 与状态 Service（业务核心，框架无关）。
 *
 * 事实源与规则：
 * - 状态机走领域层（packages/domain/src/contract.ts）：DRAFT →(activate)→ EFFECTIVE
 *   →(时间派生)→ EXPIRING_SOON → EXPIRED；任意非终态 →(terminate，强制原因)→ TERMINATED；
 * - 状态由显式动作与 evaluateContractAt(at) 确定；读取时点派生 derivedStatus 展示（不写回），
 *   列表按派生状态筛选；evaluate 端点注入时间复验并落库；
 * - 所有写操作：If-Match 乐观锁（版本条件更新，漂移 → 409 VERSION_CONFLICT）+ 强制原因
 *   + DOM-03 audited 审计（contract.create/update/activate/renew/terminate/evaluate）；
 * - contractNumber 全局唯一（DB 唯一约束 P2002 → 409）；startAt < endAt（领域 + DB CHECK 兜底）；
 * - Customer 联系方式最小权限：contact 仅 PlatformSuperAdmin/PlatformOperator 可见，
 *   Auditor 视图遮蔽为 null（Customer 角色无 contract:read，整接口 403）；
 * - 边界（DEC-007）：不管理价格/开票/收付款/电子签署；不自动创建、激活或续期 License。
 */
import { observeDataPathPhase } from '@fdp/observability';
import type { DbClient } from '@fdp/database';
import { audited, observeContractLoad } from '@fdp/database';
import {
  assertContractActivatable,
  assertContractEditable,
  assertContractTerminatable,
  assertContractWindow,
  deriveContractStatus,
  evaluateContractAt,
  renewContractWindow,
} from '@fdp/domain';
import type { ContractSnapshot, ContractStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { contractConflict, contractNotFound, contractValidationFailed, contractVersionConflict } from './errors.js';

export interface ContractDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface ContractView {
  readonly contractId: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  /** Customer 联系方式（最小权限：Auditor 视图为 null）。 */
  readonly contact: string | null;
  readonly startAt: string;
  readonly endAt: string;
  /** 落库状态（显式动作 + evaluate 写入）。 */
  readonly status: string;
  /** 查询时点派生状态（不写回；筛选依据）。 */
  readonly derivedStatus: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ContractRow {
  readonly id: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly status: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ContractDelegate {
  findFirst(args: Record<string, unknown>): Promise<ContractRow | null>;
  findMany(args: Record<string, unknown>): Promise<ContractRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<ContractRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function contracts(client: DbClient): ContractDelegate {
  return (client as unknown as Record<string, unknown>).contract as ContractDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** contact 最小权限：仅平台运营角色（SuperAdmin/Operator）可见。 */
function canViewContact(actor: ActorContext): boolean {
  return actor.roles.includes('PlatformSuperAdmin') || actor.roles.includes('PlatformOperator');
}

function toSnapshot(row: ContractRow): ContractSnapshot {
  return { status: row.status as ContractStatus, startAt: row.startAt, endAt: row.endAt };
}

function toView(row: ContractRow, at: Date, actor: ActorContext): ContractView {
  return {
    contractId: row.id,
    contractNumber: row.contractNumber,
    name: row.name,
    customerId: row.customerId,
    contact: canViewContact(actor) ? row.contact : null,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    status: row.status,
    derivedStatus: deriveContractStatus(toSnapshot(row), at),
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadContract(client: DbClient, contractId: string): Promise<ContractRow> {
  const row = await contracts(client).findFirst({ where: { id: contractId } });
  if (!row) throw contractNotFound();
  return row;
}

/** If-Match 版本条件更新；漂移 → 409 VERSION_CONFLICT。 */
async function updateWithVersion(
  tx: DbClient,
  contractId: string,
  ifMatchVersion: number,
  data: Record<string, unknown>,
  observe = false,
): Promise<ContractRow> {
  const update = async () => {
    const { count } = await contracts(tx).updateMany({
      where: { id: contractId, version: ifMatchVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (count !== 1) throw contractVersionConflict();
  };
  if (observe) await observeDataPathPhase('contract-version-update', update);
  else await update();
  const read = () => contracts(tx).findFirst({ where: { id: contractId } });
  const fresh = observe ? await observeDataPathPhase('contract-readback', read) : await read();
  if (!fresh) throw contractNotFound();
  return fresh;
}

function auditActor(actor: ActorContext): { actorId: string; actorRole: string } {
  return { actorId: actor.actorId, actorRole: actor.roles[0] };
}

function auditSnapshot(view: ContractView): Record<string, unknown> {
  return {
    contractNumber: view.contractNumber,
    status: view.status,
    startAt: view.startAt,
    endAt: view.endAt,
    version: view.version,
  };
}

// ---------- 写路径 ----------

export interface CreateContractInput {
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact?: string | undefined;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason?: string | undefined;
}

/** 创建（contract:write）：Customer 须存在；contractNumber 唯一（P2002 → 409）；初始 DRAFT。 */
export async function createContract(
  deps: ContractDeps,
  actor: ActorContext,
  input: CreateContractInput,
): Promise<ContractView> {
  assertContractWindow(input.startAt, input.endAt);
  const customer = await (
    (deps.client as unknown as Record<string, unknown>).customer as {
      findFirst(args: Record<string, unknown>): Promise<{ id: string } | null>;
    }
  ).findFirst({ where: { id: input.customerId } });
  if (!customer) throw contractNotFound();

  const at = deps.now?.() ?? new Date();
  try {
    return await audited<ContractView>(
      deps.client,
      {
        objectType: 'contract',
        objectId: input.contractNumber,
        action: 'contract.create',
        reason: input.reason ?? null,
        ...auditActor(actor),
        customerId: input.customerId,
        afterValue: { contractNumber: input.contractNumber, status: 'DRAFT', version: 1 },
      },
      async (tx) => {
        const row = await contracts(tx).create({
          data: {
            contractNumber: input.contractNumber,
            name: input.name,
            customerId: input.customerId,
            contact: input.contact ?? null,
            startAt: input.startAt,
            endAt: input.endAt,
            status: 'DRAFT',
            createdBy: actor.actorId,
          },
        });
        return toView(row, at, actor);
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw contractConflict('The contractNumber already exists');
    }
    throw err;
  }
}

export interface ContractWriteInput {
  readonly contractId: string;
  /** If-Match 版本（Handler 解析 Header 后传入）。 */
  readonly ifMatchVersion: number;
  /** 所有写操作强制原因。 */
  readonly reason: string;
}

/** 编辑（contract:write + If-Match）：name/contact 任意非终态可改；startAt/endAt 仅 DRAFT。 */
export async function updateContract(
  deps: ContractDeps,
  actor: ActorContext,
  input: ContractWriteInput & {
    readonly name?: string | undefined;
    readonly contact?: string | null | undefined;
    readonly startAt?: Date | undefined;
    readonly endAt?: Date | undefined;
  },
): Promise<ContractView> {
  const at = deps.now?.() ?? new Date();
  return audited<ContractView>(
    deps.client,
    {
      objectType: 'contract',
      objectId: input.contractId,
      action: 'contract.update',
      reason: input.reason,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as ContractView),
    },
    async (tx) => {
      const current = await observeContractLoad(() => loadContract(tx, input.contractId));
      assertContractEditable(current.status as ContractStatus, {
        touchesStartAt: input.startAt !== undefined,
        touchesEndAt: input.endAt !== undefined,
      });
      const startAt = input.startAt ?? current.startAt;
      const endAt = input.endAt ?? current.endAt;
      assertContractWindow(startAt, endAt);
      const data: Record<string, unknown> = { startAt, endAt };
      if (input.name !== undefined) data.name = input.name;
      if (input.contact !== undefined) data.contact = input.contact;
      // DRAFT 下窗口修改不改变状态；状态仅由显式动作与 evaluate 推导
      const row = await updateWithVersion(tx, input.contractId, input.ifMatchVersion, data, true);
      return toView(row, at, actor);
    },
    true,
  );
}

/** 激活（contract:write + If-Match）：DRAFT → EFFECTIVE（显式动作）。 */
export async function activateContract(
  deps: ContractDeps,
  actor: ActorContext,
  input: ContractWriteInput,
): Promise<ContractView> {
  const at = deps.now?.() ?? new Date();
  return audited<ContractView>(
    deps.client,
    {
      objectType: 'contract',
      objectId: input.contractId,
      action: 'contract.activate',
      reason: input.reason,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as ContractView),
    },
    async (tx) => {
      const current = await loadContract(tx, input.contractId);
      assertContractActivatable(current.status as ContractStatus);
      // 激活即生效：按激活时点推导（可能立即进入 EXPIRING_SOON/EXPIRED 派生区间，落库 EFFECTIVE，由 evaluate 派生）
      const row = await updateWithVersion(tx, input.contractId, input.ifMatchVersion, { status: 'EFFECTIVE' });
      return toView(row, at, actor);
    },
  );
}

/** 续约（contract:write + If-Match）：延长 endAt，状态按新窗口重推导。 */
export async function renewContract(
  deps: ContractDeps,
  actor: ActorContext,
  input: ContractWriteInput & { readonly newEndAt: Date },
): Promise<ContractView> {
  const at = deps.now?.() ?? new Date();
  return audited<ContractView>(
    deps.client,
    {
      objectType: 'contract',
      objectId: input.contractId,
      action: 'contract.renew',
      reason: input.reason,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as ContractView),
    },
    async (tx) => {
      const current = await loadContract(tx, input.contractId);
      const nextStatus = renewContractWindow(
        { status: deriveContractStatus(toSnapshot(current), at), startAt: current.startAt, endAt: current.endAt },
        input.newEndAt,
        at,
      );
      const row = await updateWithVersion(tx, input.contractId, input.ifMatchVersion, {
        endAt: input.newEndAt,
        status: nextStatus,
      });
      return toView(row, at, actor);
    },
  );
}

/** 终止（contract:write + If-Match + 强制原因）：任意非终态 → TERMINATED。 */
export async function terminateContract(
  deps: ContractDeps,
  actor: ActorContext,
  input: ContractWriteInput,
): Promise<ContractView> {
  const at = deps.now?.() ?? new Date();
  return audited<ContractView>(
    deps.client,
    {
      objectType: 'contract',
      objectId: input.contractId,
      action: 'contract.terminate',
      reason: input.reason,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as ContractView),
    },
    async (tx) => {
      const current = await loadContract(tx, input.contractId);
      assertContractTerminatable(current.status as ContractStatus);
      const row = await updateWithVersion(tx, input.contractId, input.ifMatchVersion, { status: 'TERMINATED' });
      return toView(row, at, actor);
    },
  );
}

export interface EvaluateContractResult {
  readonly view: ContractView;
  /** 是否发生时间派生迁移（无变化时无写入/审计）。 */
  readonly changed: boolean;
}

/** 可测试时间派生（contract:write；at 可注入）：到期边界复验并落库派生状态。 */
export async function evaluateContract(
  deps: ContractDeps,
  actor: ActorContext,
  contractId: string,
  ifMatchVersion: number,
  at: Date,
): Promise<EvaluateContractResult> {
  const current = await loadContract(deps.client, contractId);
  const next = evaluateContractAt(toSnapshot(current), at);
  if (next === null) return { view: toView(current, at, actor), changed: false };
  const view = await audited<ContractView>(
    deps.client,
    {
      objectType: 'contract',
      objectId: contractId,
      action: 'contract.evaluate',
      reason: `evaluate at ${at.toISOString()}`,
      ...auditActor(actor),
      beforeValue: { status: current.status, version: ifMatchVersion },
      afterValue: (result: unknown) => auditSnapshot(result as ContractView),
    },
    async (tx) => {
      const row = await updateWithVersion(tx, contractId, ifMatchVersion, { status: next });
      return toView(row, at, actor);
    },
  );
  return { view, changed: true };
}

// ---------- 读路径 ----------

export interface ListContractsFilter {
  /** 按派生状态筛选（生效/即将到期/过期/终止/草稿）。 */
  readonly status?: string | undefined;
  readonly customerId?: string | undefined;
}

/** 列表（contract:read）：读取时点派生 derivedStatus（不写回），按派生状态筛选。 */
export async function listContracts(
  deps: ContractDeps,
  actor: ActorContext,
  filter: ListContractsFilter = {},
): Promise<ContractView[]> {
  const at = deps.now?.() ?? new Date();
  if (
    filter.status !== undefined &&
    !['DRAFT', 'EFFECTIVE', 'EXPIRING_SOON', 'EXPIRED', 'TERMINATED'].includes(filter.status)
  ) {
    throw contractValidationFailed('status must be one of DRAFT, EFFECTIVE, EXPIRING_SOON, EXPIRED, TERMINATED');
  }
  const rows = await contracts(deps.client).findMany({
    where: { ...(filter.customerId !== undefined ? { customerId: filter.customerId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return rows
    .map((row) => toView(row, at, actor))
    .filter((v) => filter.status === undefined || v.derivedStatus === filter.status);
}

/** 详情（contract:read）。 */
export async function getContract(deps: ContractDeps, actor: ActorContext, contractId: string): Promise<ContractView> {
  return toView(await loadContract(deps.client, contractId), deps.now?.() ?? new Date(), actor);
}
