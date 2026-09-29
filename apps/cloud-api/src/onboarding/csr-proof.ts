import { createHash, createPublicKey, verify } from 'node:crypto';
import forge from 'node-forge';
import { OnboardingApiError, validationFailed } from './errors.js';

/** 目前项目 CA 仅支持 RSA；CSR 自签名验证同时证明申请方持有对应私钥。 */
export function inspectCsr(csrPem: string): { fingerprint: string; publicKeyPem: string } {
  if (csrPem.length > 8192 || !csrPem.startsWith('-----BEGIN CERTIFICATE REQUEST-----')) {
    throw validationFailed('csrPem must be a PEM certificate signing request (at most 8192 characters)');
  }
  try {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const key = csr.publicKey as forge.pki.rsa.PublicKey | null;
    if (!csr.verify() || !key || key.n.bitLength() < 2048) throw new Error('invalid CSR');
    const publicKeyPem = forge.pki.publicKeyToPem(key);
    const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return { fingerprint: createHash('sha256').update(spki).digest('hex'), publicKeyPem };
  } catch {
    throw validationFailed('csrPem is invalid or its signature cannot be verified');
  }
}

export interface StatusProof {
  readonly requestId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export function verifyStatusProof(publicKeyPem: string, proof: StatusProof, now: Date): void {
  const timestamp = Number(proof.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now.getTime() - timestamp) > 300_000) {
    throw new OnboardingApiError('UNAUTHENTICATED');
  }
  if (!/^[A-Za-z0-9_-]{22,86}$/.test(proof.nonce) || !/^[A-Za-z0-9+/=]{128,1024}$/.test(proof.signature)) {
    throw new OnboardingApiError('UNAUTHENTICATED');
  }
  const signed = `GET\n/api/v1/device/onboarding/status\n${proof.requestId}\n${proof.timestamp}\n${proof.nonce}`;
  if (!verify('sha256', Buffer.from(signed), createPublicKey(publicKeyPem), Buffer.from(proof.signature, 'base64'))) {
    throw new OnboardingApiError('UNAUTHENTICATED');
  }
}
