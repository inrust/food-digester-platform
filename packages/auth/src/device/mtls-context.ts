/**
 * AUTH-03 API Gateway mTLS 客户端证书上下文。
 *
 * API Gateway REST 自定义域名开启 mTLS 后，TLS 握手（CA 链验证）在网关完成，
 * `$context.identity.clientCert` 透传客户端证书信息。本模块只做 PEM → 指纹计算；
 * CA 链验证不等于应用白名单，白名单校验见 verifier.ts。
 */
import { createHash } from 'node:crypto';
import { unauthenticated } from '../errors.js';

/** API Gateway `$context.identity.clientCert` 的子集（REST API mTLS）。 */
export interface ClientCertIdentity {
  readonly clientCertPem?: string;
  readonly serialNumber?: string;
  readonly subjectDN?: string;
  readonly issuerDN?: string;
  readonly validity?: {
    readonly notBefore?: string;
    readonly notAfter?: string;
  };
}

/**
 * 证书指纹：PEM → DER → SHA-256（hex），与 device_certificates.fingerprint 对应。
 * PEM 非法 → 401（不区分原因）。
 */
export function certificateFingerprintFromPem(pem: string): string {
  const base64Body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (base64Body.length === 0) throw unauthenticated();
  const der = Buffer.from(base64Body, 'base64');
  if (der.length === 0) throw unauthenticated();
  return createHash('sha256').update(der).digest('hex');
}
