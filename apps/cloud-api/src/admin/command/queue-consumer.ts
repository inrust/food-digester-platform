import type { CommandPublisherDeps } from './publisher.js';
import { publishCommand } from './publisher.js';
import { commandPublishKey, COMMAND_PUBLISH_EVENT } from './immediate.js';
export interface CommandQueueEvent {
  readonly Records?: readonly {
    readonly messageId: string;
    readonly body: string;
    readonly attributes?: { readonly SentTimestamp?: string; readonly ApproximateReceiveCount?: string };
  }[];
}
/** Duplicate notifications share the same durable lease; transport/active-lease failures remain retryable. */
export async function consumeCommandNotifications(
  deps: CommandPublisherDeps,
  event: CommandQueueEvent,
  emit: (row: Readonly<Record<string, string>>) => void = () => {},
) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    let outcome = 'INVALID_NOTIFICATION',
      commandId: string | undefined;
    try {
      const body: unknown = JSON.parse(record.body);
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).length !== 1 ||
        !('commandId' in body) ||
        typeof body.commandId !== 'string' ||
        !/^[A-Z0-9][A-Z0-9-]{0,127}$/.test(body.commandId)
      )
        throw Error('INVALID_NOTIFICATION');
      commandId = body.commandId;
      const command = await deps.client.deviceCommand.findFirst({ where: { id: commandId } });
      if (!command) outcome = 'COMMAND_NOT_FOUND';
      else if (
        ['PUBLISHED', 'ACKNOWLEDGED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(command.status) ||
        (command.expiresAt && command.expiresAt.getTime() <= (deps.now?.() ?? new Date()).getTime())
      ) {
        outcome = 'TERMINAL_NO_PUBLISH';
        await deps.client.outboxEvent.updateMany({
          where: {
            idempotencyKey: commandPublishKey(commandId),
            eventType: COMMAND_PUBLISH_EVENT,
            OR: [{ leaseToken: null }, { leaseUntil: { lte: deps.now?.() ?? new Date() } }],
          },
          data: {
            status: 'PUBLISHED',
            publishedAt: deps.now?.() ?? new Date(),
            lastError: 'TERMINAL_NO_PUBLISH',
            leaseToken: null,
            leaseUntil: null,
          },
        });
      } else {
        const result = await publishCommand(deps, commandId);
        outcome = result.status;
        if (result.status === 'PUBLISH_FAILED') batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } catch {
      if (commandId) {
        outcome = 'RETRY_REQUIRED';
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    // Never log body, exception text, user identity, or arbitrary caller-controlled identifiers.
    try {
      emit({
        event: 'command.notification.consumed',
        sqsMessageId: /^[a-f0-9-]{36}$/.test(record.messageId) ? record.messageId : 'unknown',
        ...(commandId ? { commandId } : {}),
        outcome,
      });
    } catch {
      /* consumption does not depend on logs */
    }
  }
  return { batchItemFailures };
}
