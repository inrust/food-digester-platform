import { hasPermission } from '@fdp/auth';
import type { ActorContext, Role } from '@fdp/auth';
import { commandDenyReason } from '@fdp/contracts/mqtt/catalogs.js';
import { resolveCommandGateStatus } from '@fdp/domain';
import type { DbClient } from '@fdp/database';

interface LicenseDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
}

const licenses = (client: DbClient): LicenseDelegate =>
  (client as unknown as Record<string, unknown>).license as LicenseDelegate;

/** BE-CMD-01 与 Dashboard 共用的有效 License + REMOTE_CONTROL Entitlement 查询。 */
export async function hasEffectiveRemoteControlEntitlement(
  client: DbClient,
  deviceId: string,
  now: Date,
): Promise<boolean> {
  return Boolean(
    await licenses(client).findFirst({
      where: {
        deviceId,
        status: { in: ['Active', 'ExpiringSoon'] },
        validFrom: { lte: now },
        validTo: { gt: now },
        entitlements: { some: { code: 'REMOTE_CONTROL', enabled: true } },
      },
    }),
  );
}

export interface CommandAuthorizationInput {
  readonly actor: ActorContext;
  readonly deviceCustomerId: string | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly command: string;
  readonly hasRemoteControlEntitlement: boolean;
}

/** 无副作用授权判定；null 表示与 createCommand 相同的授权门全部通过。 */
export function commandAuthorizationDenyReason(input: CommandAuthorizationInput): string | null {
  if (!input.actor.roles.some((role) => hasPermission(role as Role, 'command:send'))) return 'FORBIDDEN';
  if (
    !input.deviceCustomerId ||
    (input.actor.actorType === 'customer' && input.deviceCustomerId !== input.actor.customerId)
  ) {
    return 'FORBIDDEN';
  }
  const stateReason = commandDenyReason(
    input.command as Parameters<typeof commandDenyReason>[0],
    resolveCommandGateStatus(input.lifecycleStatus, input.operationalStatus) as never,
  );
  if (stateReason !== null) return stateReason;
  return input.hasRemoteControlEntitlement ? null : 'FORBIDDEN';
}
