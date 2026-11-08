import { createHash } from 'node:crypto';

export const TARGET = Object.freeze({
  accountId: '065986019555',
  region: 'ap-southeast-1',
  stackName: 'fdp-test-app',
  controlTable: 'fdp-test-live-image-control',
  payloadTable: 'fdp-test-live-image-payload',
  poolId: 'ap-southeast-1_hZMX8LpFo',
  dbSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-rds-credentials-hBessK',
  licenseSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-license-signing-key-OVgupB',
});
export class Rejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new Rejected(code);
}
export const isHash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(s);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const jsonHash = (v: unknown) => digest(canonical(v));
export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  const keys = Object.keys(value);
  requireThat(
    required.every((k) => keys.includes(k)) && keys.every((k) => [...required, ...optional].includes(k)),
    'UNKNOWN_OR_MISSING_FIELDS',
  );
}
export interface Binding {
  deviceId: string;
  customerId: string;
  siteId: string;
  certificateFingerprint: string;
  certificateId: string;
}
export interface IdentitySpec {
  username: string;
  email: string;
}
export interface Manifest {
  formatVersion: 1;
  runId: string;
  applicationCommit: string;
  toolCommit: string;
  approvalRef: string;
  window: { startsAt: string; endsAt: string };
  serialNumber: string;
  model: string;
  customerName: string;
  siteName: string;
  csrPublicKeyFingerprint: string;
  provisioner: IdentitySpec;
  viewer: IdentitySpec;
  writerVersion: string;
  verifierVersion: string;
  licenseSecretVersion: string;
  verifierBinding: Binding | null;
  verification: {
    licenseId: string;
    licenseVersion: number;
    snapshotEtag: string;
    expiresAt: string;
    observedAt?: string;
  } | null;
}
export interface BoundManifest {
  manifest: Readonly<Manifest>;
  hash: string;
}
export interface Invocation {
  invokedFunctionArn: string;
  functionVersion: string;
}
export function bindManifest(raw: string, expectedHash: string): BoundManifest {
  requireThat(
    Buffer.byteLength(raw) <= 16384 && isHash(expectedHash) && digest(raw) === expectedHash,
    'MANIFEST_DIGEST_MISMATCH',
  );
  const m: Manifest = JSON.parse(raw);
  exactKeys(m, [
    'formatVersion',
    'runId',
    'applicationCommit',
    'toolCommit',
    'approvalRef',
    'window',
    'serialNumber',
    'model',
    'customerName',
    'siteName',
    'csrPublicKeyFingerprint',
    'provisioner',
    'viewer',
    'writerVersion',
    'verifierVersion',
    'licenseSecretVersion',
    'verifierBinding',
    'verification',
  ]);
  requireThat(
    m.formatVersion === 1 &&
      /^IMG21-[A-Za-z0-9-]{1,80}$/u.test(m.runId) &&
      [m.applicationCommit, m.toolCommit].every((s) => typeof s === 'string' && /^[a-f0-9]{40}$/u.test(s)) &&
      /^img21-[a-f0-9]{16}$/u.test(m.serialNumber) &&
      /^[A-Za-z0-9_-]{1,80}$/u.test(m.model) &&
      [m.approvalRef, m.customerName, m.siteName].every(
        (s) => typeof s === 'string' && s.length > 0 && s.length <= 200,
      ) &&
      isHash(m.csrPublicKeyFingerprint),
    'INVALID_MANIFEST',
  );
  exactKeys(m.window, ['startsAt', 'endsAt']);
  const start = Date.parse(m.window.startsAt),
    end = Date.parse(m.window.endsAt);
  requireThat(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      new Date(start).toISOString() === m.window.startsAt &&
      new Date(end).toISOString() === m.window.endsAt &&
      end > start &&
      end - start <= 5400000,
    'INVALID_WINDOW',
  );
  for (const who of [m.provisioner, m.viewer]) {
    exactKeys(who, ['username', 'email']);
    requireThat(
      typeof who.username === 'string' &&
        who.username.startsWith(m.serialNumber + '-') &&
        who.username.length <= 128 &&
        typeof who.email === 'string' &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(who.email),
      'INVALID_IDENTITY_BINDING',
    );
  }
  requireThat(
    m.provisioner.username !== m.viewer.username && m.provisioner.email !== m.viewer.email,
    'IDENTITIES_MUST_DIFFER',
  );
  requireThat(
    [m.writerVersion, m.verifierVersion].every(
      (s) => typeof s === 'string' && (s === 'PUBLISHED' || /^[1-9][0-9]*$/u.test(s)),
    ) &&
      typeof m.licenseSecretVersion === 'string' &&
      /^[A-Za-z0-9-]{32,64}$/u.test(m.licenseSecretVersion),
    'NUMERIC_VERSION_AND_SECRET_VERSION_REQUIRED',
  );
  if (m.verifierBinding !== null) {
    exactKeys(m.verifierBinding, ['deviceId', 'customerId', 'siteId', 'certificateFingerprint', 'certificateId']);
    requireThat(
      [m.verifierBinding.deviceId, m.verifierBinding.customerId, m.verifierBinding.siteId].every(isUuid) &&
        isHash(m.verifierBinding.certificateFingerprint) &&
        /^[A-Za-z0-9_-]{1,128}$/u.test(m.verifierBinding.certificateId),
      'INVALID_DEVICE_BINDING',
    );
  }
  if (m.verification !== null) {
    exactKeys(m.verification, ['licenseId', 'licenseVersion', 'snapshotEtag', 'expiresAt'], ['observedAt']);
    if (m.verification.observedAt !== undefined) {
      const observed = Date.parse(m.verification.observedAt),
        expires = Date.parse(m.verification.expiresAt);
      requireThat(
        Number.isFinite(observed) &&
          new Date(observed).toISOString() === m.verification.observedAt &&
          observed >= start &&
          expires > observed &&
          expires - observed <= 300000,
        'SNAPSHOT_FIVE_MINUTE_LIMIT',
      );
    }
    requireThat(
      m.verifierBinding &&
        isUuid(m.verification.licenseId) &&
        Number.isSafeInteger(m.verification.licenseVersion) &&
        m.verification.licenseVersion > 0 &&
        isHash(m.verification.snapshotEtag) &&
        Number.isFinite(Date.parse(m.verification.expiresAt)) &&
        new Date(m.verification.expiresAt).toISOString() === m.verification.expiresAt &&
        Date.parse(m.verification.expiresAt) <= end,
      'INVALID_VERIFICATION_BINDING',
    );
  }
  // Detached immutable configuration. A caller's event can never supply or mutate this object.
  const freeze = (v: any): any => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return Object.freeze({ manifest: freeze(m), hash: expectedHash });
}
export function checkWindow(bound: BoundManifest, now: number) {
  requireThat(
    Number.isFinite(now) &&
      Date.parse(bound.manifest.window.startsAt) <= now &&
      now < Date.parse(bound.manifest.window.endsAt),
    'WINDOW_NOT_OPEN',
  );
}
export function checkInvocation(bound: BoundManifest, kind: 'writer' | 'verifier', ctx: Invocation) {
  const suffix = kind === 'writer' ? 'controlled-writer' : 'license-verifier';
  const version = bound.manifest[kind === 'writer' ? 'writerVersion' : 'verifierVersion'];
  requireThat(
    /^[1-9][0-9]*$/u.test(ctx.functionVersion) &&
      (version === 'PUBLISHED' || ctx.functionVersion === version) &&
      ctx.invokedFunctionArn ===
        `arn:aws:lambda:${TARGET.region}:${TARGET.accountId}:function:fdp-test-img21-${suffix}:${ctx.functionVersion}`,
    'PUBLISHED_VERSION_REQUIRED',
  );
}
export const ACTIONS = [
  'SEED_PROVISIONER',
  'SEED_VIEWER',
  'BIND_DEVICE',
  'ENABLE_PREVIEW',
  'DISABLE_PREVIEW',
  'DISABLE_IDENTITY',
  'READ_OPERATION',
] as const;
export type Action = (typeof ACTIONS)[number];
export interface WriteRequest {
  runId: string;
  manifestHash: string;
  operationId: string;
  action: Action;
  deviceId?: string;
  userId?: string;
  expectedAuthEpoch?: number;
}
export function parseWriteRequest(input: unknown, bound: BoundManifest): WriteRequest {
  exactKeys(input, ['runId', 'manifestHash', 'operationId', 'action'], ['deviceId', 'userId', 'expectedAuthEpoch']);
  requireThat(
    Buffer.byteLength(JSON.stringify(input)) <= 2048 &&
      input.runId === bound.manifest.runId &&
      input.manifestHash === bound.hash &&
      isHash(input.operationId) &&
      ACTIONS.includes(input.action as Action),
    'REQUEST_BINDING',
  );
  const action = input.action as Action;
  const fields =
    action === 'BIND_DEVICE'
      ? ['deviceId']
      : ['ENABLE_PREVIEW', 'DISABLE_PREVIEW'].includes(action)
        ? ['deviceId', 'expectedAuthEpoch']
        : action === 'DISABLE_IDENTITY'
          ? ['userId', 'deviceId', 'expectedAuthEpoch']
          : [];
  requireThat(
    Object.keys(input).every((k) => ['runId', 'manifestHash', 'operationId', 'action', ...fields].includes(k)),
    'ACTION_FIELDS_REJECTED',
  );
  for (const k of ['deviceId', 'userId']) if (input[k] !== undefined) requireThat(isUuid(input[k]), 'UUID_REQUIRED');
  if (input.expectedAuthEpoch !== undefined)
    requireThat(
      Number.isSafeInteger(input.expectedAuthEpoch) && Number(input.expectedAuthEpoch) >= 0,
      'EPOCH_REQUIRED',
    );
  if (action === 'BIND_DEVICE') requireThat(isUuid(input.deviceId), 'UUID_REQUIRED');
  if (['ENABLE_PREVIEW', 'DISABLE_PREVIEW'].includes(action))
    requireThat(isUuid(input.deviceId) && input.expectedAuthEpoch !== undefined, 'DEVICE_EPOCH_REQUIRED');
  if (action === 'DISABLE_IDENTITY') requireThat(isUuid(input.userId), 'UUID_REQUIRED');
  return input as unknown as WriteRequest;
}
