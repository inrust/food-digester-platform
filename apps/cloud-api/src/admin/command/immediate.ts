import type { DbClient } from '@fdp/database';
export const COMMAND_PUBLISH_EVENT = 'COMMAND_PUBLISH_REQUESTED';
export const commandPublishKey = (id: string): string => `COMMAND_PUBLISH_REQUESTED:${id}`;
export async function persistCommandPublishRequest(tx: DbClient, commandId: string): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      eventType: COMMAND_PUBLISH_EVENT,
      aggregateType: 'device_command',
      aggregateId: commandId,
      idempotencyKey: commandPublishKey(commandId),
      payload: { commandId },
      status: 'PENDING',
    },
  });
}
export interface ImmediateCommandNotifier {
  readonly notifyAuthorizedCommand?: (commandId: string) => Promise<void>;
  readonly onImmediatePublishFailure?: (commandId: string) => void;
}
/** Notification is a post-commit hint. Durable state stays eligible for scheduled recovery. */
export async function notifyCommittedCommand(
  deps: ImmediateCommandNotifier,
  commandId: string,
  status: string,
): Promise<void> {
  if (!['AUTHORIZED', 'PUBLISH_FAILED', 'PUBLISHING'].includes(status) || !deps.notifyAuthorizedCommand) return;
  try {
    await deps.notifyAuthorizedCommand(commandId);
  } catch {
    try {
      deps.onImmediatePublishFailure?.(commandId);
    } catch {
      /* never fail an already committed command */
    }
  }
}
