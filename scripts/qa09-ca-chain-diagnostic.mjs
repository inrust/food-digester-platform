import { createPrivateKey, X509Certificate } from 'node:crypto';
const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
function readChain(pem) {
  if (typeof pem !== 'string' || pem.length > 65536) return { certificates: [], parseable: false };
  const blocks = pem.match(certificatePattern) ?? [];
  if (blocks.length > 8) return { certificates: [], parseable: false };
  try {
    return { certificates: blocks.map((block) => new X509Certificate(block)), parseable: true };
  } catch {
    return { certificates: [], parseable: false };
  }
}
function describe(chain, now) {
  return chain.map((certificate, index) => {
    const parent = chain[index + 1] ?? certificate;
    return {
      index,
      fingerprint256: certificate.fingerprint256,
      ca: certificate.ca,
      validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(),
      currentlyValid: now >= new Date(certificate.validFrom) && now < new Date(certificate.validTo),
      issuerMatchesParent: certificate.checkIssued(parent),
      signatureValidWithParent: certificate.verify(parent.publicKey),
      selfIssued: certificate.checkIssued(certificate),
      selfSignatureValid: certificate.verify(certificate.publicKey),
    };
  });
}
function validChain(chain, parseable) {
  return (
    parseable &&
    chain.length >= 1 &&
    chain.length <= 3 &&
    chain.every((c) => c.ca && c.currentlyValid && c.issuerMatchesParent && c.signatureValidWithParent)
  );
}
/** Run in AWS only with real Secret values. The returned object has a fixed public metadata schema. */
export function diagnoseCaChain(secretString, truststorePem, now = new Date()) {
  const truststore = readChain(truststorePem);
  const trust = describe(truststore.certificates, now);
  let secret;
  try {
    if (typeof secretString !== 'string' || secretString.length > 65536) throw Error('INVALID');
    secret = JSON.parse(secretString);
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw Error('INVALID');
  } catch {
    return { schema: 'fdp-qa09-ca-chain/v1', completed: false, errorCode: 'SECRET_JSON_INVALID' };
  }
  const fields = {
    caCertificatePemPresent: typeof secret.caCertificatePem === 'string' && secret.caCertificatePem.length > 0,
    caPrivateKeyPemPresent: typeof secret.caPrivateKeyPem === 'string' && secret.caPrivateKeyPem.length > 0,
    caCertificateChainPemPresent:
      typeof secret.caCertificateChainPem === 'string' && secret.caCertificateChainPem.length > 0,
  };
  const signing = readChain(secret.caCertificatePem);
  const configured = readChain(
    (typeof secret.caCertificatePem === 'string' ? secret.caCertificatePem : '') +
      (typeof secret.caCertificateChainPem === 'string' ? secret.caCertificateChainPem : ''),
  );
  const chain = describe(configured.certificates, now);
  let keyParseable = false,
    keyMatchesSigningCertificate = false,
    keyMatchesTruststoreFirstCertificate = false;
  try {
    if (!fields.caPrivateKeyPemPresent || secret.caPrivateKeyPem.length > 32768) throw Error('INVALID');
    const key = createPrivateKey(secret.caPrivateKeyPem);
    keyParseable = true;
    keyMatchesSigningCertificate = signing.certificates[0]?.checkPrivateKey(key) ?? false;
    keyMatchesTruststoreFirstCertificate = truststore.certificates[0]?.checkPrivateKey(key) ?? false;
  } catch {
    // Never expose crypto exceptions, PEM, Secret values or arbitrary fields.
  }
  const configuredFingerprints = chain.map((c) => c.fingerprint256);
  const truststoreFingerprints = trust.map((c) => c.fingerprint256);
  const findings = [];
  if (!fields.caCertificatePemPresent || !fields.caPrivateKeyPemPresent) findings.push('REQUIRED_SECRET_FIELD_MISSING');
  if (!configured.parseable || !chain.length) findings.push('PUBLIC_CHAIN_UNPARSEABLE_OR_EMPTY');
  if (chain.length > 3) findings.push('WORKER_CHAIN_TOO_LONG');
  if (chain.some((c) => !c.ca)) findings.push('NON_CA_CERTIFICATE');
  if (chain.some((c) => !c.currentlyValid)) findings.push('CERTIFICATE_OUTSIDE_VALIDITY');
  if (chain.some((c) => !c.issuerMatchesParent || !c.signatureValidWithParent))
    findings.push('CHAIN_PARENT_OR_SIGNATURE_INVALID');
  if (chain.length && !chain.at(-1).selfSignatureValid) findings.push('TERMINAL_CERTIFICATE_NOT_SELF_SIGNED');
  if (!keyParseable) findings.push('PRIVATE_KEY_UNPARSEABLE');
  else if (!keyMatchesSigningCertificate) findings.push('SIGNING_KEY_MISMATCH');
  const signingFingerprint = signing.certificates[0]?.fingerprint256 ?? null;
  const truststoreOrderMatches =
    configuredFingerprints.length === truststoreFingerprints.length &&
    configuredFingerprints.every((fingerprint, index) => fingerprint === truststoreFingerprints[index]);
  const result = {
    schema: 'fdp-qa09-ca-chain/v1',
    completed: true,
    fields,
    configuredChainParseable: configured.parseable,
    configuredChainCount: chain.length,
    configuredChain: chain,
    workerChainValid: validChain(chain, configured.parseable),
    privateKeyParseable: keyParseable,
    privateKeyMatchesSigningCertificate: keyMatchesSigningCertificate,
    signingCertificateFingerprint256: signingFingerprint,
    truststoreParseable: truststore.parseable,
    truststoreChainCount: trust.length,
    truststoreChain: trust,
    truststoreChainValid: validChain(trust, truststore.parseable),
    configuredChainEqualsTruststoreInOrder: truststoreOrderMatches,
    signingCertificateMatchesTruststoreFirst:
      signingFingerprint !== null && signingFingerprint === truststoreFingerprints[0],
    privateKeyMatchesTruststoreFirstCertificate: keyMatchesTruststoreFirstCertificate,
    missingTruststoreFingerprints: truststoreFingerprints.filter((f) => !configuredFingerprints.includes(f)),
    findings,
  };
  secret = undefined;
  return result;
}
