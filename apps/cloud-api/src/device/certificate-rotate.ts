/** CSR-only rotation. New and old identities overlap until both channels confirm or the 24h window expires. */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction, acquireTransactionLock } from '@fdp/database';
import { deviceCertificateMetadata, buildDevicePolicy } from '@fdp/aws-clients';
import type { DataKeyProvider } from '@fdp/aws-clients';
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  CERTIFICATE_ROTATION_WINDOW_MS,
  claimDevicePublicKey,
  certificateFingerprintFromPem,
  SecurePackageService,
} from '@fdp/auth';
import type { DeviceAuthContext } from '@fdp/auth';
import { inspectCsr } from '../onboarding/csr-proof.js';
import type { IotCertificateResult, IotProvisioningPort } from '../provisioning/index.js';

export type RotationErrorCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'CONFLICT';

export const ROTATION_ERROR_HTTP_STATUS: Readonly<Record<RotationErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
} as const;

export class CertificateRotationError extends Error {
  override readonly name = 'CertificateRotationError';
  readonly code: RotationErrorCode;

  constructor(code: RotationErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ROTATION_ERROR_HTTP_STATUS[this.code];
  }
}

export interface RotationConfig {
  readonly region: string;
  readonly accountId: string;
  readonly certificateValiditySeconds: number;
  readonly policyNamePrefix?: string;
}

export interface RotationServiceDeps {
  readonly client: DbClient;
  readonly iot: IotProvisioningPort;
  readonly keyProvider: DataKeyProvider;
  readonly config: RotationConfig;
  readonly now?: () => Date;
}

export interface RotationResult {
  readonly certificateId: string;
  readonly certificatePem: string;
  readonly certificateChain: string;
  /** 新证书生效时间（UTC ISO 时间戳，双证书窗口起点）。 */
  readonly effectiveDate: string;
  /** UTC 到期日（YYYY-MM-DD）。 */
  readonly expiryDate: string;
  /** 双证书窗口记录：被轮换的旧证书。 */
  readonly rotatedFromId: string;
  /** HTTP 响应成功提交后调用，销毁唯一密文包。 */
  readonly confirmDelivery: () => Promise<void>;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly rotatedFromId: string | null;
  readonly packageCiphertext: Uint8Array | null;
  readonly claimedAt: Date | null;
  readonly certificatePem: string | null;
  readonly publicKeyFingerprint: string | null;
  readonly rotationConfirmedAt: Date | null;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

function certificates(client: DbClient) {
  return (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<CertificateRow>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export async function rotateCertificate(
  deps: RotationServiceDeps,
  auth: DeviceAuthContext,
  currentCertificateId: string | undefined,
  csrPem: string | undefined,
): Promise<RotationResult> {
  if (!currentCertificateId) {
    throw new CertificateRotationError('VALIDATION_FAILED', 'currentCertificateId is required');
  }
  // 仅旧证书属于当前 mTLS 身份对应设备时允许（跨设备/错误声明 → 403）
  if (currentCertificateId !== auth.certificateId) {
    throw new CertificateRotationError(
      'FORBIDDEN',
      'currentCertificateId does not match the authenticated certificate',
    );
  }

  if (!csrPem) throw new CertificateRotationError('VALIDATION_FAILED', 'csrPem is required');
  let fingerprint: string;
  try {
    fingerprint = inspectCsr(csrPem).fingerprint;
  } catch {
    throw new CertificateRotationError('VALIDATION_FAILED', 'Invalid CSR');
  }
  const current = await certificates(deps.client).findFirst({
    where: { id: auth.certificateId, deviceId: auth.deviceId, status: 'ACTIVE' },
  });
  if (!current || (current.rotatedFromId && !current.rotationConfirmedAt))
    throw new CertificateRotationError('CONFLICT', 'The current certificate is awaiting rotation verification');
  const oldKeyFingerprint =
    current.publicKeyFingerprint ??
    (current.certificatePem ? deviceCertificateMetadata(current.certificatePem).publicKeyFingerprint : null);
  if (!oldKeyFingerprint)
    throw new CertificateRotationError('CONFLICT', 'Current certificate key metadata is unavailable');
  if (oldKeyFingerprint === fingerprint)
    throw new CertificateRotationError('VALIDATION_FAILED', 'Rotation requires a new device key');
  if (!(await claimDevicePublicKey(deps.client, auth.deviceId, fingerprint)))
    throw new CertificateRotationError('CONFLICT', 'CSR key is bound to another device');
  let registered: IotCertificateResult | undefined;
  try {
    return await withTransaction(
      deps.client,
      async (tx) => {
        await acquireTransactionLock(tx, `certificate-rotation:${auth.deviceId}`);
        const result = await rotateUnderLock(
          {
            ...deps,
            client: tx,
            iot: {
              ...deps.iot,
              issueAndRegisterCertificateFromCsr: async (csr, deviceId) => {
                registered = await deps.iot.issueAndRegisterCertificateFromCsr(csr, deviceId);
                return registered;
              },
            },
          },
          auth,
          fingerprint,
          csrPem,
        );
        // Callback must use the committed root client, never the transaction-scoped client.
        return {
          ...result,
          confirmDelivery: async () => {
            const secure = new SecurePackageService({
              db: deps.client,
              keyProvider: deps.keyProvider,
              config: {
                retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
                maxClaims: 1,
                now: deps.now ?? (() => new Date()),
              },
            });
            await secure.confirmPackageDelivery(result.certificateId);
          },
        };
      },
      { timeout: 30000 },
    );
  } catch (error) {
    if (registered) {
      const at = deps.now?.() ?? new Date();
      await (deps.client as any).deviceCertificate.upsert({
        where: { id: registered.certificateId },
        create: {
          id: registered.certificateId,
          deviceId: auth.deviceId,
          fingerprint: certificateFingerprintFromPem(registered.certificatePem),
          certificateArn: registered.certificateArn,
          certificatePem: registered.certificatePem,
          status: 'REVOKED',
          revokedAt: at,
          notBefore: at,
          notAfter: at,
          iotDeactivationPending: true,
        },
        update: { status: 'REVOKED', revokedAt: at, iotDeactivationPending: true },
      });
      await recordAudit(deps.client, {
        objectType: 'deviceCertificate',
        objectId: registered.certificateId,
        action: 'CERT_ROTATION_ISSUANCE_FAILED',
        result: 'FAILURE',
        afterValue: { iotDeactivationPending: true },
      });
    }
    throw error;
  }
}

async function rotateUnderLock(
  deps: RotationServiceDeps,
  auth: DeviceAuthContext,
  fingerprint: string,
  csrPem: string,
): Promise<RotationResult> {
  const now = deps.now?.() ?? new Date();
  const certs = certificates(deps.client);
  const stillActive = await certs.findFirst({
    where: {
      id: auth.certificateId,
      deviceId: auth.deviceId,
      status: 'ACTIVE',
      revokedAt: null,
      notBefore: { lte: now },
      notAfter: { gt: now },
    },
  });
  if (!stillActive) throw new CertificateRotationError('FORBIDDEN', 'Current certificate is no longer active');

  const securePackage = new SecurePackageService({
    db: deps.client,
    keyProvider: deps.keyProvider,
    config: {
      retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
      maxClaims: 1,
      now: deps.now ?? (() => new Date()),
    },
  });

  // 重试短路：同旧证书的未确认轮换已存在
  const existing = await certs.findFirst({
    where: { deviceId: auth.deviceId, rotatedFromId: auth.certificateId, status: 'ACTIVE', rotationConfirmedAt: null },
  });
  if (existing && existing.publicKeyFingerprint !== fingerprint)
    throw new CertificateRotationError(
      'CONFLICT',
      'Use the same pending CSR until replacement is revoked or confirmed',
    );
  if (existing?.packageCiphertext && existing.claimedAt === null) {
    const payload = await securePackage.preparePackageDelivery(existing.id, {
      kind: 'deviceCertificate',
      context: auth,
    });
    const parsed = parseRotationPackage(payload);
    return {
      certificateId: existing.id,
      certificatePem: parsed.certificatePem,
      certificateChain: parsed.certificateChain,
      effectiveDate: existing.notBefore.toISOString().slice(0, 10),
      expiryDate: existing.notAfter.toISOString().slice(0, 10),
      rotatedFromId: auth.certificateId,
      confirmDelivery: async () => {
        await securePackage.confirmPackageDelivery(existing.id);
      },
    };
  }
  if (existing?.packageCiphertext && existing.claimedAt !== null) {
    await securePackage.revokeUnconfirmedDelivery(existing.id);
    await certs.updateMany({ where: { id: existing.id }, data: { iotDeactivationPending: true } });
  }
  if (existing && !existing.packageCiphertext && existing.claimedAt !== null) {
    throw new CertificateRotationError(
      'CONFLICT',
      'The replacement certificate was delivered and is awaiting MQTT and REST verification',
    );
  }
  if (existing && !existing.packageCiphertext && existing.claimedAt === null) {
    // 封包前失败的遗留：DEC-003 丢失处置，REVOKED 后重签（有界替换）
    await certs.updateMany({
      where: { id: existing.id, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now, iotDeactivationPending: true },
    });
  }

  const reused = await certs.findFirst({
    where: { publicKeyFingerprint: fingerprint, deviceId: { not: auth.deviceId } },
  });
  if (reused) throw new CertificateRotationError('CONFLICT', 'The CSR key belongs to another device');
  const cert = await deps.iot.issueAndRegisterCertificateFromCsr(csrPem, auth.deviceId);
  if ('privateKey' in cert) throw new CertificateRotationError('CONFLICT', 'Issuer returned a device private key');
  const metadata = deviceCertificateMetadata(cert.certificatePem);
  if (metadata.publicKeyFingerprint !== fingerprint)
    throw new CertificateRotationError('CONFLICT', 'Certificate does not match CSR');
  const policy = buildDevicePolicy({
    region: deps.config.region,
    accountId: deps.config.accountId,
    thingName: auth.deviceId,
    ...(deps.config.policyNamePrefix ? { policyNamePrefix: deps.config.policyNamePrefix } : {}),
  });
  await deps.iot.ensurePolicy(policy.policyName, policy.policyDocument);
  await deps.iot.attachPolicy(policy.policyName, cert.certificateArn);
  await deps.iot.attachThingPrincipal(auth.deviceId, cert.certificateArn);

  const notAfter = metadata.notAfter;
  await withTransaction(deps.client, async (tx) => {
    await certificates(tx).create({
      data: {
        id: cert.certificateId,
        deviceId: auth.deviceId,
        status: 'ACTIVE',
        certificatePem: cert.certificatePem,
        rotatedFromId: auth.certificateId,
        ...metadata,
        certificateArn: cert.certificateArn,
        certificateChain: cert.certificateChain,
        rotationDeadlineAt: new Date(now.getTime() + CERTIFICATE_ROTATION_WINDOW_MS),
      },
    });
    await recordAudit(tx, {
      objectType: 'deviceCertificate',
      objectId: cert.certificateId,
      action: 'CERT_ROTATION_START',
      result: 'SUCCESS',
      beforeValue: { certificateId: auth.certificateId, deviceId: auth.deviceId },
      afterValue: { certificateId: cert.certificateId, rotatedFromId: auth.certificateId },
    });
  });

  // 一次领取包只含公钥证书与 CA chain，设备私钥始终留在本地。
  await securePackage.storePackage(
    cert.certificateId,
    Buffer.from(
      JSON.stringify({ certificatePem: cert.certificatePem, certificateChain: cert.certificateChain }),
      'utf8',
    ),
  );

  const delivery = parseRotationPackage(
    await securePackage.preparePackageDelivery(cert.certificateId, {
      kind: 'deviceCertificate',
      context: auth,
    }),
  );

  return {
    certificateId: cert.certificateId,
    certificatePem: delivery.certificatePem,
    certificateChain: delivery.certificateChain,
    effectiveDate: metadata.notBefore.toISOString().slice(0, 10),
    expiryDate: notAfter.toISOString().slice(0, 10),
    rotatedFromId: auth.certificateId,
    confirmDelivery: async () => {
      await securePackage.confirmPackageDelivery(cert.certificateId);
    },
  };
}

function parseRotationPackage(payload: Uint8Array): { certificatePem: string; certificateChain: string } {
  const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>;
  if (
    typeof parsed.certificatePem !== 'string' ||
    typeof parsed.certificateChain !== 'string' ||
    'privateKey' in parsed
  ) {
    throw new CertificateRotationError('CONFLICT', 'The certificate package is invalid');
  }
  return { certificatePem: parsed.certificatePem, certificateChain: parsed.certificateChain };
}
