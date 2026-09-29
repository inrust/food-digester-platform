import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import forge from 'node-forge';
import { assert, describe, test } from 'vitest';
import { createProjectCaCertificateIssuer } from '../src/project-ca-certificate-issuer.js';

function testCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2036-01-01T00:00:00Z');
  certificate.setSubject([{ name: 'commonName', value: 'FDP Test CA' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    caCertificatePem: forge.pki.certificateToPem(certificate),
    caPrivateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('项目 CA 设备证书签发器', () => {
  test('对设备 CSR 公钥签发且不返回私钥', async () => {
    const ca = testCa();
    const pair = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = pair.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'SN-CSR-ISSUER' }]);
    csr.sign(pair.privateKey, forge.md.sha256.create());
    const issuer = createProjectCaCertificateIssuer({
      secretId: 'fdp-test-device-ca',
      validitySeconds: 31_536_000,
      client: { send: async () => ({ SecretString: JSON.stringify(ca) }) } as unknown as SecretsManagerClient,
      now: () => new Date('2026-09-21T00:00:00Z'),
    });
    const issued = await issuer.issue(forge.pki.certificationRequestToPem(csr));
    const leaf = forge.pki.certificateFromPem(issued.certificatePem);
    assert.isUndefined(issued.privateKey);
    assert.equal(forge.pki.publicKeyToPem(leaf.publicKey), forge.pki.publicKeyToPem(pair.publicKey));
    assert.isTrue(forge.pki.certificateFromPem(ca.caCertificatePem).verify(leaf));
  });
  test('签发可由 CA 验证且包含客户端认证用途的叶证书，并缓存 Secret', async () => {
    const ca = testCa();
    const calls: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        calls.push(command);
        return { SecretString: JSON.stringify(ca) };
      },
    } as unknown as SecretsManagerClient;
    const issuer = createProjectCaCertificateIssuer({
      secretId: 'fdp-test-device-ca',
      validitySeconds: 31_536_000,
      client,
      now: () => new Date('2026-09-21T00:00:00Z'),
    });

    const first = await issuer.issue();
    const second = await issuer.issue();
    const caCertificate = forge.pki.certificateFromPem(ca.caCertificatePem);
    const leaf = forge.pki.certificateFromPem(first.certificatePem);
    assert.isString(first.privateKey);
    const privateKey = forge.pki.privateKeyFromPem(first.privateKey!);

    assert.equal(calls.length, 1);
    assert.instanceOf(calls[0], GetSecretValueCommand);
    assert.isTrue(caCertificate.verify(leaf));
    assert.equal(leaf.subject.getField('CN').value.toString().startsWith('fdp-device-'), true);
    assert.equal((leaf.getExtension('basicConstraints') as { cA?: boolean } | null)?.cA, false);
    assert.equal((leaf.getExtension('extKeyUsage') as { clientAuth?: boolean } | null)?.clientAuth, true);
    const authorityKeyIdentifier = leaf.getExtension('authorityKeyIdentifier') as { value?: string } | null;
    assert.include(authorityKeyIdentifier?.value, caCertificate.generateSubjectKeyIdentifier().getBytes());
    assert.notInclude(authorityKeyIdentifier?.value, leaf.generateSubjectKeyIdentifier().getBytes());
    const derivedPublicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
    assert.equal(forge.pki.publicKeyToPem(derivedPublicKey), forge.pki.publicKeyToPem(leaf.publicKey));
    assert.notEqual(first.certificatePem, second.certificatePem);
  });
});
