import { liveImageIoLifetime } from '@fdp/database';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, PutItemCommandInput } from '@aws-sdk/client-dynamodb';
import type {
  LiveImageControl,
  LiveImageControlVersion,
  LiveImageFrameCommit,
  LiveImageFrameReceipt,
  LiveImageFrameStore,
  LiveImageLatestStore,
  LiveImageStoredFrame,
} from '@fdp/domain';

type Item = Record<string, AttributeValue>;
export type LiveImageDynamoCommand =
  GetItemCommand | PutItemCommand | TransactGetItemsCommand | TransactWriteItemsCommand;
/** Deliberately small SDK port so local tests exercise actual DynamoDB wire commands. */
export interface LiveImageDynamoTransport {
  send(
    command: LiveImageDynamoCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<{ Item?: Item; Responses?: Array<{ Item?: Item }> }>;
}
export interface LiveImageDynamoOptions {
  controlTable: string;
  payloadTable: string;
  region?: string;
  transport?: LiveImageDynamoTransport;
  now?: () => number;
  timeoutMs?: number;
}
const str = (value: string): AttributeValue => ({ S: value });
const num = (value: number): AttributeValue => ({ N: String(value) });
const optional = (value: string | number | null): AttributeValue =>
  value === null ? { NULL: true } : typeof value === 'number' ? num(value) : str(value);
const key = (deviceId: string, sk: string) => ({ pk: str(`DEVICE#${deviceId}`), sk: str(sk) });
const controlItem = (control: LiveImageControl): Item => ({
  ...key(control.deviceId, 'CONTROL'),
  payload: str(JSON.stringify(control)),
  revision: num(control.revision),
  authEpoch: num(control.authEpoch),
  customerId: optional(control.customerId),
  streamId: optional(control.streamId),
  enabled: { BOOL: control.enabled },
  activeUntilMs: num(Math.max(0, ...control.viewers.map((v) => v.expiresAtMs))),
  latestCapturedAtMs: optional(control.latestCapturedAtMs),
  lastNewFrameAtMs: optional(control.lastNewFrameAtMs),
});
function parse<T>(item: Item | undefined, kind: 'control' | 'frame' | 'receipt', deviceId: string): T | null {
  if (!item) return null;
  if (item.pk?.S !== `DEVICE#${deviceId}` || !item.payload?.S) throw new Error('INVALID_LIVE_IMAGE_RECORD');
  if (Buffer.byteLength(item.payload.S, 'utf8') > 380 * 1024) throw new Error('INVALID_LIVE_IMAGE_RECORD_SIZE');
  const value = JSON.parse(item.payload.S) as Record<string, unknown>;
  if (value.deviceId !== deviceId || !Number.isSafeInteger(value.authEpoch) || Number(value.authEpoch) < 1)
    throw new Error('INVALID_LIVE_IMAGE_RECORD');
  if (
    kind === 'control' &&
    (!(value.customerId === null || typeof value.customerId === 'string') ||
      !(value.streamId === null || typeof value.streamId === 'string') ||
      ![value.latestCapturedAtMs, value.lastNewFrameAtMs].every(
        (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
      ) ||
      !Array.isArray(value.viewers) ||
      value.viewers.length > 16 ||
      value.viewers.some(
        (v: Record<string, unknown>) =>
          !v ||
          typeof v.actorId !== 'string' ||
          typeof v.viewerId !== 'string' ||
          typeof v.expiresAtMs !== 'number' ||
          !Number.isFinite(v.expiresAtMs),
      ))
  )
    throw new Error('INVALID_LIVE_IMAGE_CONTROL');
  if (
    kind === 'control' &&
    (!Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.viewers))
  )
    throw new Error('INVALID_LIVE_IMAGE_CONTROL');
  if (
    kind !== 'control' &&
    (typeof value.streamId !== 'string' || typeof value.frameId !== 'string' || typeof value.expiresAt !== 'string')
  )
    throw new Error('INVALID_LIVE_IMAGE_PAYLOAD');
  if (
    kind !== 'control' &&
    (typeof value.customerId !== 'string' ||
      !Number.isSafeInteger(value.ttl) ||
      !Number.isFinite(Date.parse(String(value.receivedAt))) ||
      !Number.isFinite(Date.parse(String(value.expiresAt))))
  )
    throw new Error('INVALID_LIVE_IMAGE_PAYLOAD');
  if (
    kind === 'frame' &&
    (value.mimeType !== 'image/jpeg' ||
      typeof value.imageBase64 !== 'string' ||
      !value.imageBase64.length ||
      value.imageBase64.length > 174764 ||
      !Number.isFinite(Date.parse(String(value.capturedAt))))
  )
    throw new Error('INVALID_LIVE_IMAGE_FRAME');
  if (
    kind === 'receipt' &&
    (typeof value.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.requestHash) ||
      typeof value.dedupUntilMs !== 'number' ||
      !Number.isFinite(value.dedupUntilMs))
  )
    throw new Error('INVALID_LIVE_IMAGE_RECEIPT');
  return value as T;
}
function conflict(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (e.name === 'ConditionalCheckFailedException') return true;
  return (
    e.name === 'TransactionCanceledException' &&
    !!e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed') &&
    e.CancellationReasons.every((r) => r.Code === 'None' || r.Code === 'ConditionalCheckFailed')
  );
}
function versionCondition(
  expected: LiveImageControlVersion | null,
): Pick<PutItemCommandInput, 'ConditionExpression' | 'ExpressionAttributeValues'> {
  return expected
    ? {
        ConditionExpression: 'revision = :revision AND authEpoch = :epoch',
        ExpressionAttributeValues: { ':revision': num(expected.revision), ':epoch': num(expected.authEpoch) },
      }
    : { ConditionExpression: 'attribute_not_exists(pk)' };
}
function validateReplacement(expected: LiveImageControlVersion | null, next: LiveImageControl, deviceId: string) {
  if (
    next.deviceId !== deviceId ||
    next.revision !== (expected?.revision ?? 0) + 1 ||
    next.authEpoch < (expected?.authEpoch ?? 1) ||
    !Number.isSafeInteger(next.revision) ||
    !Number.isSafeInteger(next.authEpoch)
  )
    throw new Error('INVALID_CONTROL_VERSION');
}

export class DynamoLiveImageStore implements LiveImageFrameStore, LiveImageLatestStore {
  private readonly transport: LiveImageDynamoTransport;
  private readonly now: () => number;
  constructor(private readonly options: LiveImageDynamoOptions) {
    if (!options.controlTable || !options.payloadTable || options.controlTable === options.payloadTable)
      throw new Error('LIVE_IMAGE_TABLES_REQUIRED');
    if (options.timeoutMs !== undefined && (options.timeoutMs <= 0 || options.timeoutMs > 1500))
      throw new Error('LIVE_IMAGE_IO_TIMEOUT');
    this.now = options.now ?? Date.now;
    this.transport =
      options.transport ??
      new DynamoDBClient({ ...(options.region ? { region: options.region } : {}), maxAttempts: 1 });
  }
  private async send(command: LiveImageDynamoCommand, deadline = Infinity) {
    const lifetime = liveImageIoLifetime();
    const timeout = Math.min(this.options.timeoutMs ?? 1000, deadline - this.now(), lifetime?.remainingMs ?? Infinity);
    if (timeout <= 0) throw new Error('LIVE_IMAGE_DEADLINE_EXPIRED');
    if (command instanceof PutItemCommand && Buffer.byteLength(JSON.stringify(command.input.Item)) > 380 * 1024)
      throw new Error('LIVE_IMAGE_ITEM_TOO_LARGE');
    if (
      command instanceof TransactWriteItemsCommand &&
      command.input.TransactItems?.some(
        (part) => part.Put && Buffer.byteLength(JSON.stringify(part.Put.Item)) > 380 * 1024,
      )
    )
      throw new Error('LIVE_IMAGE_ITEM_TOO_LARGE');
    const timed = AbortSignal.timeout(Math.max(1, Math.floor(timeout)));
    const response = await this.transport.send(command, {
      abortSignal: lifetime ? AbortSignal.any([timed, lifetime.signal]) : timed,
    });
    liveImageIoLifetime();
    return response;
  }
  async readControl(deviceId: string): Promise<LiveImageControl | null> {
    const response = await this.send(
      new GetItemCommand({ TableName: this.options.controlTable, Key: key(deviceId, 'CONTROL'), ConsistentRead: true }),
    );
    return parse(response.Item, 'control', deviceId);
  }
  async compareAndSwap(
    deviceId: string,
    expected: LiveImageControlVersion | null,
    replacement: LiveImageControl,
  ): Promise<boolean> {
    validateReplacement(expected, replacement, deviceId);
    try {
      await this.send(
        new PutItemCommand({
          TableName: this.options.controlTable,
          Item: controlItem(replacement),
          ...versionCondition(expected),
        }),
      );
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }
  async readUploadSnapshot(deviceId: string, streamId: string, frameId: string) {
    const response = await this.send(
      new TransactGetItemsCommand({
        TransactItems: [
          { Get: { TableName: this.options.controlTable, Key: key(deviceId, 'CONTROL') } },
          { Get: { TableName: this.options.payloadTable, Key: key(deviceId, `DEDUP#${streamId}#${frameId}`) } },
        ],
      }),
    );
    if (response.Responses?.length !== 2) throw new Error('INVALID_LIVE_IMAGE_SNAPSHOT');
    return {
      control: parse<LiveImageControl>(response.Responses[0]?.Item, 'control', deviceId),
      receipt: parse<LiveImageFrameReceipt>(response.Responses[1]?.Item, 'receipt', deviceId),
    };
  }
  async readLatestSnapshot(deviceId: string) {
    const response = await this.send(
      new TransactGetItemsCommand({
        TransactItems: [
          { Get: { TableName: this.options.controlTable, Key: key(deviceId, 'CONTROL') } },
          { Get: { TableName: this.options.payloadTable, Key: key(deviceId, 'FRAME') } },
        ],
      }),
    );
    if (response.Responses?.length !== 2) throw new Error('INVALID_LIVE_IMAGE_SNAPSHOT');
    return {
      control: parse<LiveImageControl>(response.Responses[0]?.Item, 'control', deviceId),
      frame: parse<LiveImageStoredFrame>(response.Responses[1]?.Item, 'frame', deviceId),
    };
  }
  async commitFrame(commit: LiveImageFrameCommit): Promise<boolean> {
    const { control, frame, receipt, expected } = commit;
    validateReplacement(expected, control, frame.deviceId);
    const now = this.now(),
      capturedAt = Date.parse(frame.capturedAt),
      receivedAt = Date.parse(frame.receivedAt);
    const activeUntil = Math.max(0, ...control.viewers.map((v) => v.expiresAtMs));
    const deadline = Math.min(activeUntil, Date.parse(frame.expiresAt), capturedAt + 10000, receivedAt + 10000);
    if (!Number.isFinite(deadline) || deadline <= now) return false;
    if (
      !control.enabled ||
      control.authEpoch !== expected.authEpoch ||
      frame.authEpoch !== control.authEpoch ||
      frame.customerId !== control.customerId ||
      frame.streamId !== control.streamId ||
      control.latestCapturedAtMs !== capturedAt ||
      control.lastNewFrameAtMs !== receivedAt ||
      receipt.deviceId !== frame.deviceId ||
      receipt.streamId !== frame.streamId ||
      receipt.frameId !== frame.frameId ||
      receipt.authEpoch !== frame.authEpoch ||
      receipt.customerId !== frame.customerId
    )
      throw new Error('INVALID_FRAME_COMMIT');
    const values: Record<string, AttributeValue> = {
      ':revision': num(expected.revision),
      ':epoch': num(expected.authEpoch),
      ':customer': str(frame.customerId),
      ':stream': str(frame.streamId),
      ':yes': { BOOL: true },
      ':now': num(now),
      ':capture': num(capturedAt),
      ':limit': num(receivedAt - 1000),
      ':nullType': str('NULL'),
    };
    try {
      await this.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.options.controlTable,
                Item: controlItem(control),
                ConditionExpression:
                  'revision = :revision AND authEpoch = :epoch AND customerId = :customer AND streamId = :stream AND enabled = :yes AND activeUntilMs > :now AND (attribute_type(latestCapturedAtMs, :nullType) OR latestCapturedAtMs < :capture) AND (attribute_type(lastNewFrameAtMs, :nullType) OR lastNewFrameAtMs <= :limit)',
                ExpressionAttributeValues: values,
              },
            },
            {
              Put: {
                TableName: this.options.payloadTable,
                Item: { ...key(frame.deviceId, 'FRAME'), payload: str(JSON.stringify(frame)), ttl: num(frame.ttl) },
              },
            },
            {
              Put: {
                TableName: this.options.payloadTable,
                Item: {
                  ...key(frame.deviceId, `DEDUP#${frame.streamId}#${frame.frameId}`),
                  payload: str(JSON.stringify(receipt)),
                  ttl: num(receipt.ttl),
                  dedupUntilMs: num(receipt.dedupUntilMs),
                },
                ConditionExpression: 'attribute_not_exists(pk) OR dedupUntilMs <= :now',
                ExpressionAttributeValues: { ':now': num(now) },
              },
            },
          ],
        }),
        deadline,
      );
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  }
}
export function createLiveImageStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DynamoLiveImageStore {
  return new DynamoLiveImageStore({
    controlTable: env.LIVE_IMAGE_CONTROL_TABLE ?? '',
    payloadTable: env.LIVE_IMAGE_PAYLOAD_TABLE ?? '',
    ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
  });
}

/** Legacy composition roots can initialize without preview config; first actual use still fails closed. */
export function createLazyLiveImageStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveImageFrameStore & LiveImageLatestStore {
  const captured = { ...env };
  let store: DynamoLiveImageStore | undefined;
  const get = () => (store ??= createLiveImageStoreFromEnv(captured));
  return {
    readControl: (...args) => get().readControl(...args),
    compareAndSwap: (...args) => get().compareAndSwap(...args),
    readUploadSnapshot: (...args) => get().readUploadSnapshot(...args),
    readLatestSnapshot: (...args) => get().readLatestSnapshot(...args),
    commitFrame: (...args) => get().commitFrame(...args),
  };
}
