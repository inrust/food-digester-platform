import forge from 'node-forge';
import { randomBytes } from 'node:crypto';

export function csrFixture(commonName = 'TEST-CSR') {
  const pair = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = pair.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(pair.privateKey, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr), pair };
}
const caPair = forge.pki.rsa.generateKeyPair(2048);
const ca = forge.pki.createCertificate();
ca.publicKey = caPair.publicKey;
ca.serialNumber = '01';
ca.validity.notBefore = new Date('2026-01-01T00:00:00Z');
ca.validity.notAfter = new Date('2036-01-01T00:00:00Z');
ca.setSubject([{ name: 'commonName', value: 'LOCAL TEST CA' }]);
ca.setIssuer(ca.subject.attributes);
ca.setExtensions([{ name: 'basicConstraints', cA: true }]);
ca.sign(caPair.privateKey, forge.md.sha256.create());
export function certificateForCsr(csrPem: string, deviceId: string, notBefore = new Date('2026-08-27T08:00:00Z')) {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = csr.publicKey!;
  leaf.serialNumber = '01' + randomBytes(12).toString('hex');
  leaf.validity.notBefore = notBefore;
  leaf.validity.notAfter = new Date('2028-01-01T00:00:00Z');
  leaf.setSubject([{ name: 'commonName', value: deviceId }]);
  leaf.setIssuer(ca.subject.attributes);
  leaf.sign(caPair.privateKey, forge.md.sha256.create());
  return { certificatePem: forge.pki.certificateToPem(leaf), certificateChain: forge.pki.certificateToPem(ca) };
}
