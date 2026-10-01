import { createHash, X509Certificate } from 'node:crypto';

/** Metadata is derived from the signed certificate, never from configured duration or CSR subject. */
export function deviceCertificateMetadata(certificatePem: string) {
  const certificate = new X509Certificate(certificatePem);
  return {
    fingerprint: createHash('sha256').update(certificate.raw).digest('hex'),
    publicKeyFingerprint: createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    serialNumber: certificate.serialNumber,
    issuer: certificate.issuer,
    notBefore: new Date(certificate.validFrom),
    notAfter: new Date(certificate.validTo),
  };
}
