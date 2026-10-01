import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import forge from 'node-forge';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';

export interface IssuedDeviceCertificate {
  readonly certificatePem: string;
  readonly certificateChain: string;
}

export interface DeviceCertificateIssuer {
  issue(csrPem: string, deviceId: string): Promise<IssuedDeviceCertificate>;
}

export interface ProjectCaCertificateIssuerConfig {
  readonly secretId: string;
  readonly validitySeconds: number;
  readonly client?: SecretsManagerClient;
  readonly region?: string;
  readonly now?: () => Date;
}

interface ProjectCaSecret {
  readonly caCertificatePem: string;
  readonly caPrivateKeyPem: string;
  readonly caCertificateChainPem?: string;
}

function parseSecret(value: string | undefined): ProjectCaSecret {
  if (!value) throw new Error('项目 CA Secret 缺少 SecretString');
  const parsed = JSON.parse(value) as Partial<ProjectCaSecret>;
  if (!parsed.caCertificatePem || !parsed.caPrivateKeyPem) {
    throw new Error('项目 CA Secret 必须包含 caCertificatePem 与 caPrivateKeyPem');
  }
  return {
    caCertificatePem: parsed.caCertificatePem,
    caPrivateKeyPem: parsed.caPrivateKeyPem,
    ...(parsed.caCertificateChainPem ? { caCertificateChainPem: parsed.caCertificateChainPem } : {}),
  };
}

function positiveSerialNumber(): string {
  const bytes = randomBytes(20);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes.toString('hex');
}

/** 测试环境项目 CA 签发器。CA 私钥只在 Lambda 内存中出现，不写日志或数据库。 */
export function createProjectCaCertificateIssuer(config: ProjectCaCertificateIssuerConfig): DeviceCertificateIssuer {
  const client = config.client ?? new SecretsManagerClient(config.region ? { region: config.region } : {});
  let cached: ProjectCaSecret | undefined;

  const loadCa = async (): Promise<ProjectCaSecret> => {
    if (cached) return cached;
    const response = await client.send(new GetSecretValueCommand({ SecretId: config.secretId }));
    cached = parseSecret(response.SecretString);
    return cached;
  };

  return {
    async issue(csrPem: string, deviceId: string) {
      const ca = await loadCa();
      const caCertificate = forge.pki.certificateFromPem(ca.caCertificatePem);
      const caPrivateKey = forge.pki.privateKeyFromPem(ca.caPrivateKeyPem);
      if (!/^[A-Za-z0-9:_@.-]{1,128}$/.test(deviceId)) throw new Error('Invalid device identity');
      if (!csrPem || csrPem.length > 8192) throw new Error('Invalid CSR');
      const csr = forge.pki.certificationRequestFromPem(csrPem);
      const publicKey = csr.publicKey as forge.pki.rsa.PublicKey | null;
      if (
        !csr.verify() ||
        !publicKey ||
        publicKey.n.bitLength() < 2048 ||
        !['1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13'].includes(csr.signatureOid ?? '')
      )
        throw new Error('Invalid CSR');
      const certificateChain = ca.caCertificatePem + (ca.caCertificateChainPem ?? '');
      const blocks = certificateChain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      if (!blocks.length || blocks.length > 3) throw new Error('Invalid project CA chain');
      const chain = blocks.map((pem) => new X509Certificate(pem));
      const chainNow = config.now?.() ?? new Date();
      for (let index = 0; index < chain.length; index++) {
        const current = chain[index]!;
        const parent = chain[index + 1] ?? current;
        if (
          !current.ca ||
          !current.checkIssued(parent) ||
          !current.verify(parent.publicKey) ||
          chainNow < new Date(current.validFrom) ||
          chainNow >= new Date(current.validTo)
        )
          throw new Error('Invalid project CA chain');
      }
      if (!chain[0]!.checkPrivateKey(createPrivateKey(ca.caPrivateKeyPem))) throw new Error('Project CA key mismatch');
      const certificate = forge.pki.createCertificate();
      const now = config.now?.() ?? new Date();

      certificate.publicKey = publicKey;
      certificate.serialNumber = positiveSerialNumber();
      certificate.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
      certificate.validity.notAfter = new Date(
        Math.min(
          now.getTime() + config.validitySeconds * 1000,
          ...chain.map((item) => new Date(item.validTo).getTime()),
        ),
      );
      certificate.setSubject([{ name: 'commonName', value: deviceId }]);
      certificate.setIssuer(caCertificate.subject.attributes);
      const caSubjectKeyIdentifier = caCertificate.generateSubjectKeyIdentifier().getBytes();
      certificate.setExtensions([
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', clientAuth: true },
        { name: 'subjectKeyIdentifier' },
        { name: 'subjectAltName', altNames: [{ type: 6, value: `urn:fdp:device:${encodeURIComponent(deviceId)}` }] },
        { name: 'authorityKeyIdentifier', keyIdentifier: caSubjectKeyIdentifier },
      ]);
      certificate.sign(caPrivateKey, forge.md.sha256.create());

      return {
        certificatePem: forge.pki.certificateToPem(certificate),
        certificateChain,
      };
    },
  };
}
