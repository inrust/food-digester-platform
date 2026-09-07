/**
 * BE-CERT-01 Certificate Status API：GET /api/v1/device/certificate/status（框架无关）。
 *
 * - 只允许查询当前 mTLS 身份对应的证书：证书由 AUTH-03 按指纹白名单认证，
 *   查询以 auth.certificateId 为唯一键；query.deviceId 提供时必须与身份一致（跨设备 → 403）；
 * - 外部状态推导：REVOKED（撤销标记）> EXPIRED（已过 notAfter）> EXPIRING（剩余天数 ≤ 阈值）
 *   > ACTIVE；日期一律 UTC（expiryDate 为 YYYY-MM-DD，daysRemaining 为 UTC 整日差）；
 * - 响应绝不包含 PEM/私钥（certificatePem 列不读取，私钥从不落库）。
 *
 * 功能边界：不自动轮换，不发送到期告警。
 */
import type { DbClient } from '@fdp/database';
import { AuthError, withDeviceAuth } from '@fdp/auth';
import type { ClientCertIdentity, DeviceAuthContext } from '@fdp/auth';

// ---------- 状态推导（纯函数，边界日由单元测试锁定） ----------

export type ExternalCertificateStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'REVOKED';

export interface CertificateStatusView {
  readonly status: ExternalCertificateStatus;
  /** UTC 到期日（YYYY-MM-DD）。 */
  readonly expiryDate: string;
  /** UTC 整日剩余天数（EXPIRED/REVOKED 为 0）。 */
  readonly daysRemaining: number;
}

const DAY_MS = 86_400_000;

export function deriveCertificateStatus(
  cert: { readonly storedStatus: string; readonly revokedAt: Date | null; readonly notAfter: Date },
  now: Date,
  expiringSoonDays: number,
): CertificateStatusView {
  const expiryDate = cert.notAfter.toISOString().slice(0, 10);
  if (cert.storedStatus === 'REVOKED' || cert.revokedAt !== null) {
    return { status: 'REVOKED', expiryDate, daysRemaining: 0 };
  }
  const remainingMs = cert.notAfter.getTime() - now.getTime();
  if (remainingMs <= 0 || cert.storedStatus === 'EXPIRED') {
    return { status: 'EXPIRED', expiryDate, daysRemaining: 0 };
  }
  const daysRemaining = Math.floor(remainingMs / DAY_MS);
  if (daysRemaining <= expiringSoonDays) {
    return { status: 'EXPIRING', expiryDate, daysRemaining };
  }
  return { status: 'ACTIVE', expiryDate, daysRemaining };
}

// ---------- Handler ----------

export interface CertificateStatusRequest {
  /** API Gateway 代理事件的 `$context.identity.clientCert`（适配层注入）。 */
  readonly identity?: ClientCertIdentity | undefined;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly requestId: string;
}

export interface CertificateStatusResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CertificateStatusHandlerDeps {
  readonly client: DbClient;
  /** EXPIRING 阈值（天），缺省 30；部署配置注入。 */
  readonly expiringSoonDays?: number;
  readonly now?: () => Date;
}

interface CertificateRow {
  readonly id: string;
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly notAfter: Date;
}

const DEFAULT_EXPIRING_SOON_DAYS = 30;

function toErrorResponse(err: unknown, req: CertificateStatusRequest): CertificateStatusResponse {
  if (err instanceof AuthError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message, requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

export function createCertificateStatusHandler(
  deps: CertificateStatusHandlerDeps,
): (req: CertificateStatusRequest) => Promise<CertificateStatusResponse> {
  const now = deps.now ?? (() => new Date());
  const expiringSoonDays = deps.expiringSoonDays ?? DEFAULT_EXPIRING_SOON_DAYS;

  const guarded = withDeviceAuth<CertificateStatusRequest, CertificateStatusResponse>(
    {
      client: deps.client,
      identityOf: (req) => req.identity,
      // 只允许查询当前 mTLS 身份：query.deviceId 提供时由 AUTH-03 强制与证书绑定设备一致（否则 403）
      deviceIdOf: (req) => req.query?.deviceId,
      now,
    },
    async (req, auth: DeviceAuthContext) => {
      const certificates = (deps.client as unknown as Record<string, unknown>).deviceCertificate as {
        findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
      };
      // 以认证身份的 certificateId 为唯一键查询；不读取 certificatePem
      const cert = await certificates.findFirst({ where: { id: auth.certificateId } });
      if (!cert) throw new Error('certificate row missing after authentication');
      const view = deriveCertificateStatus(
        { storedStatus: cert.status, revokedAt: cert.revokedAt, notAfter: cert.notAfter },
        now(),
        expiringSoonDays,
      );
      return {
        status: 200,
        body: { certificateId: cert.id, ...view },
      };
    },
  );

  return async (req) => {
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
