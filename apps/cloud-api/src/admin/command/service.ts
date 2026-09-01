/**
 * BE-CMD-01 Command 创建与授权 Service（框架无关）。
 *
 * 规则：
 * - 创建即授权（状态直接落 AUTHORIZED；CREATED 为瞬时内部态不落库）；
 * - 校验链：角色（Handler permission 门）→ Customer 租户（Customer 角色强制 device 归属，
 *   跨 Customer → 404）→ 设备状态门（领域层 resolveCommandGateStatus + assertCommandAllowed，
 *   云端 suspension 权威优先于设备上报）→ Entitlement（有效 License 且 REMOTE_CONTROL enabled，
 *   无 → 403）→ 命令白名单/参数/timeoutSec（领域层封闭校验）→ 高风险确认凭证（confirmText
 *   精确匹配 + confirmedAt TTL 内，过期确认 400）；
 * - meta.id 即 commandId（DEC-006）：客户端可提供 commandId 做幂等；重复创建（同 commandId
 *   同 device/command/timeoutSec）→ 200 replayed=true 无新写入/审计；冲突 → 409；
 * - requestedBy 取自身份上下文（actor.actorId），不信任客户端声明；requestTime/expiresAt
 *   服务器内部计算（expiresAt = requestTime + timeoutSec）；confirmedBy = actor.actorId；
 * - 审计：DOM-03 audited，action command.authorize；
 * - 功能边界：不发布 MQTT（Outbox/发布属 BE-CMD-02），不执行设备动作。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  CommandError,
  assertCommandAllowed,
  assertCommandParams,
  assertHighRiskConfirmation,
  assertKnownCommand,
  resolveCommandGateStatus,
} from '@fdp/domain';
import type { CommandConfirmation, CommandSpec } from '@fdp/domain';
import {
  commandConflict,
  commandForbidden,
  commandNotFound,
  commandStateNotAllowed,
  commandValidationFailed,
} from './errors.js';

export interface CommandDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

// ---------- 行类型与数据访问 ----------

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly lifecycleStatus: string;
}

interface LatestStateRow {
  readonly operationalStatus: string | null;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
}

interface LatestStateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<LatestStateRow | null>;
}

interface LicenseDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
}

interface CommandRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: string;
  readonly category: string;
  readonly highRisk: boolean;
  readonly status: string;
  readonly requestedBy: string;
  readonly requestTime: Date;
  readonly timeoutSec: number;
  readonly expiresAt: Date | null;
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly version: number;
}

interface CommandDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CommandRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<CommandRow>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function latestStates(client: DbClient): LatestStateDelegate {
  return (client as unknown as Record<string, unknown>).deviceLatestState as LatestStateDelegate;
}

function licenses(client: DbClient): LicenseDelegate {
  return (client as unknown as Record<string, unknown>).license as LicenseDelegate;
}

function commands(client: DbClient): CommandDelegate {
  return (client as unknown as Record<string, unknown>).deviceCommand as CommandDelegate;
}

// ---------- DTO ----------

export interface CommandView {
  readonly commandId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly command: string;
  readonly category: string;
  readonly highRisk: boolean;
  /** 创建即授权：AUTHORIZED。 */
  readonly status: string;
  readonly requestedBy: string;
  readonly requestTime: string;
  readonly timeoutSec: number;
  readonly expiresAt: string;
  readonly remarks: string | null;
  readonly confirmedBy: string | null;
  readonly version: number;
}

export interface CommandCreateResult extends CommandView {
  /** meta.id 幂等重放：true（无新写入/审计）。 */
  readonly replayed: boolean;
}

function toView(row: CommandRow): CommandView {
  return {
    commandId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    command: row.command,
    category: row.category,
    highRisk: row.highRisk,
    status: row.status,
    requestedBy: row.requestedBy,
    requestTime: row.requestTime.toISOString(),
    timeoutSec: row.timeoutSec,
    expiresAt: (row.expiresAt as Date).toISOString(),
    remarks: row.remarks,
    confirmedBy: row.confirmedBy,
    version: row.version,
  };
}

// ---------- 创建与授权 ----------

export interface CreateCommandInput {
  /** meta.id 即 commandId（DEC-006 幂等键）；缺省由服务器生成。 */
  readonly commandId?: string | undefined;
  readonly deviceId: string;
  readonly command: string;
  readonly timeoutSec: number;
  readonly remarks?: string | undefined;
  /** 高风险命令确认凭证。 */
  readonly confirmation?: CommandConfirmation | undefined;
}

function mapDomainError(err: unknown): never {
  if (err instanceof CommandError) {
    if (err.code === 'DEVICE_STATE_NOT_ALLOWED') throw commandStateNotAllowed(err.message);
    throw commandValidationFailed(err.message);
  }
  throw err;
}

/** Entitlement 门：设备有效 License 且 REMOTE_CONTROL enabled（无 → 403）。 */
async function assertRemoteControlEntitlement(client: DbClient, deviceId: string, now: Date): Promise<void> {
  const license = await licenses(client).findFirst({
    where: {
      deviceId,
      status: { in: ['Active', 'ExpiringSoon'] },
      validFrom: { lte: now },
      validTo: { gt: now },
      entitlements: { some: { code: 'REMOTE_CONTROL', enabled: true } },
    },
  });
  if (!license) {
    throw commandForbidden('Device has no effective license with REMOTE_CONTROL entitlement');
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** meta.id 幂等：同 commandId 且语义一致 → 重放；冲突 → 409。 */
function assertReplayCompatible(existing: CommandView, spec: CommandSpec, input: CreateCommandInput): void {
  const same =
    existing.deviceId === input.deviceId &&
    existing.command === spec.command &&
    existing.timeoutSec === input.timeoutSec;
  if (!same) {
    throw commandConflict(`commandId ${existing.commandId} already exists with different semantics`);
  }
}

export async function createCommand(
  deps: CommandDeps,
  actor: ActorContext,
  input: CreateCommandInput,
): Promise<CommandCreateResult> {
  const now = deps.now?.() ?? new Date();

  // 1. 命令白名单 + 参数/timeoutSec（领域层封闭校验）
  let spec: CommandSpec;
  try {
    spec = assertKnownCommand(input.command);
    assertCommandParams(spec.command, input.timeoutSec, input.remarks);
    assertHighRiskConfirmation(spec, input.confirmation, now);
  } catch (err) {
    mapDomainError(err);
  }

  // 2. 设备存在 + Customer 租户隔离（跨 Customer → 404）
  const device = await devices(deps.client).findFirst({ where: { id: input.deviceId } });
  if (!device) throw commandNotFound();
  if (actor.actorType === 'customer' && device.customerId !== actor.customerId) throw commandNotFound();
  if (!device.customerId) {
    throw commandValidationFailed('Device has no customer assignment');
  }

  // 3. 设备状态门（云端 suspension 权威优先；领域层）
  const latest = await latestStates(deps.client).findFirst({ where: { deviceId: input.deviceId } });
  const gateStatus = resolveCommandGateStatus(device.lifecycleStatus, latest?.operationalStatus ?? null);
  try {
    assertCommandAllowed(spec!, gateStatus);
  } catch (err) {
    mapDomainError(err);
  }

  // 4. Entitlement（REMOTE_CONTROL）
  await assertRemoteControlEntitlement(deps.client, input.deviceId, now);

  // 5. 幂等重放检查（先读后写，P2002 兜底并发）
  if (input.commandId !== undefined) {
    const existing = await commands(deps.client).findFirst({ where: { id: input.commandId } });
    if (existing) {
      const view = toView(existing);
      assertReplayCompatible(view, spec!, input);
      return { ...view, replayed: true };
    }
  }

  // 6. 落库：AUTHORIZED；requestedBy/confirmedBy/requestTime/expiresAt 服务器计算。
  // device_commands.id 无 DB 默认值：meta.id 未提供时服务器生成（审计 objectId 用真实 commandId）。
  const commandId = input.commandId ?? randomUUID();
  const expiresAt = new Date(now.getTime() + input.timeoutSec * 1000);
  try {
    return await audited<CommandCreateResult>(
      deps.client,
      {
        objectType: 'device_command',
        objectId: commandId,
        action: 'command.authorize',
        reason: input.remarks ?? null,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: device.customerId,
        afterValue: (result: CommandCreateResult) => ({
          commandId: result.commandId,
          command: result.command,
          status: result.status,
          highRisk: result.highRisk,
          confirmedBy: result.confirmedBy,
          timeoutSec: result.timeoutSec,
          expiresAt: result.expiresAt,
        }),
      },
      async (tx) => {
        const row = await commands(tx).create({
          data: {
            id: commandId,
            deviceId: input.deviceId,
            customerId: device.customerId as string,
            command: spec!.command,
            category: spec!.category,
            highRisk: spec!.highRisk,
            status: 'AUTHORIZED',
            requestedBy: actor.actorId,
            requestTime: now,
            timeoutSec: input.timeoutSec,
            expiresAt,
            remarks: input.remarks ?? null,
            confirmedBy: spec!.highRisk ? actor.actorId : null,
          },
        });
        return { ...toView(row), replayed: false };
      },
    );
  } catch (err) {
    // 并发兜底：P2002 → 重读分类（语义一致 → 重放；冲突 → 409）
    if (isUniqueViolation(err) && input.commandId !== undefined) {
      const existing = await commands(deps.client).findFirst({ where: { id: input.commandId } });
      if (existing) {
        const view = toView(existing);
        assertReplayCompatible(view, spec!, input);
        return { ...view, replayed: true };
      }
    }
    throw err;
  }
}
