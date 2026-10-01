import type { ClientCertIdentity, DeviceAuthContext } from '@fdp/auth';
import { AuthError, verifyDeviceCertificate } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp, withTransaction } from '@fdp/database';
import { hashOtaDownloadToken } from './dispatch-store.js';

export interface OtaObjectUrlSigner {
  signDownload(input: { readonly key: string; readonly expiresAt: Date }): Promise<string> | string;
}

export class OtaDownloadError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    readonly httpStatus: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'OtaDownloadError';
  }
}

type Delegate = {
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};
const delegate = (client: DbClient, name: string): Delegate =>
  (client as unknown as Record<string, unknown>)[name] as Delegate;

export async function redeemOtaDownloadGrant(
  deps: { readonly client: DbClient; readonly objectUrlSigner: OtaObjectUrlSigner; readonly now?: () => Date },
  auth: DeviceAuthContext,
  input: { readonly targetId: string; readonly token: string },
): Promise<{ readonly location: string; readonly expiresAt: string }> {
  if (!input.targetId || !/^[A-Za-z0-9_-]{32,128}$/u.test(input.token)) {
    throw new OtaDownloadError('VALIDATION_FAILED', 400, 'A valid targetId and download token are required');
  }
  const now = deps.now?.() ?? new Date();
  const tokenHash = hashOtaDownloadToken(input.token);
  const initial = (await delegate(deps.client, 'otaDownloadGrant').findFirst({ where: { tokenHash } })) as {
    targetId: string;
    deviceId: string;
    packageId: string;
    expiresAt: Date;
    usedAt: Date | null;
    revokedAt: Date | null;
  } | null;
  if (!initial || initial.targetId !== input.targetId)
    throw new OtaDownloadError('NOT_FOUND', 404, 'Download grant not found');
  if (initial.deviceId !== auth.deviceId)
    throw new OtaDownloadError('FORBIDDEN', 403, 'Download grant is bound to another device');
  if (initial.usedAt || initial.revokedAt || initial.expiresAt.getTime() <= now.getTime()) {
    throw new OtaDownloadError('CONFLICT', 409, 'Download grant is expired, used, or revoked');
  }
  const target = (await delegate(deps.client, 'otaTarget').findFirst({ where: { id: input.targetId } })) as {
    deviceId: string;
    campaignId: string;
    status: string;
  } | null;
  if (
    !target ||
    target.deviceId !== auth.deviceId ||
    !['NOTIFIED', 'DOWNLOADING', 'INSTALLING'].includes(target.status)
  ) {
    throw new OtaDownloadError('FORBIDDEN', 403, 'Target is not eligible for download');
  }
  const campaign = (await delegate(deps.client, 'otaCampaign').findFirst({ where: { id: target.campaignId } })) as {
    packageId: string;
    status: string;
  } | null;
  if (!campaign || campaign.status !== 'RUNNING' || campaign.packageId !== initial.packageId) {
    throw new OtaDownloadError('FORBIDDEN', 403, 'Campaign is not eligible for download');
  }
  const pkg = (await delegate(deps.client, 'firmwarePackage').findFirst({ where: { id: initial.packageId } })) as {
    s3Key: string;
    status: string;
  } | null;
  if (!pkg || pkg.status !== 'VERIFIED')
    throw new OtaDownloadError('FORBIDDEN', 403, 'Package is not eligible for download');

  const location = await deps.objectUrlSigner.signDownload({ key: pkg.s3Key, expiresAt: initial.expiresAt });
  const consumed = await withTransaction(deps.client, async (tx) =>
    delegate(tx, 'otaDownloadGrant').updateMany({
      where: {
        tokenHash,
        targetId: input.targetId,
        deviceId: auth.deviceId,
        packageId: initial.packageId,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    }),
  );
  if (consumed.count !== 1) throw new OtaDownloadError('CONFLICT', 409, 'Download grant was already consumed');
  return { location, expiresAt: initial.expiresAt.toISOString() };
}

export interface DeviceOtaDownloadRequest {
  readonly identity?: ClientCertIdentity;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly requestId: string;
}

export interface DeviceOtaDownloadResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function createDeviceOtaDownloadHandler(deps: {
  readonly client: DbClient;
  readonly objectUrlSigner: OtaObjectUrlSigner;
  readonly now?: () => Date;
}): (request: DeviceOtaDownloadRequest) => Promise<DeviceOtaDownloadResponse> {
  const now = deps.now ?? (() => new Date());
  return async (request) => {
    try {
      const auth = await verifyDeviceCertificate(deps.client, request.identity, { now: now() });
      const result = await redeemOtaDownloadGrant(deps, auth, {
        targetId: request.params?.targetId ?? '',
        token: request.query?.token ?? '',
      });
      return {
        status: 307,
        headers: { location: result.location, 'cache-control': 'no-store' },
        body: undefined,
      };
    } catch (error) {
      if (error instanceof AuthError || error instanceof OtaDownloadError) {
        return {
          status: error.httpStatus,
          headers: { 'cache-control': 'no-store' },
          body: { error: { code: error.code, message: error.message, requestId: request.requestId } },
        };
      }
      const mapped = mapDbErrorToHttp(error);
      return {
        status: mapped.status === 500 ? 500 : mapped.status,
        headers: { 'cache-control': 'no-store' },
        body: {
          error: {
            code: mapped.status === 500 ? 'INTERNAL_ERROR' : mapped.code,
            message: mapped.status === 500 ? 'Internal server error' : 'The request failed',
            requestId: request.requestId,
          },
        },
      };
    }
  };
}
