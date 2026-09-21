import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import forge from 'node-forge';
import { randomBytes, randomUUID } from 'node:crypto';

export interface IssuedDeviceCertificate {
  readonly certificatePem: string;
  readonly privateKey: string;
}

export interface DeviceCertificateIssuer {
  issue(): Promise<IssuedDeviceCertificate>;
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
}

function parseSecret(value: string | undefined): ProjectCaSecret {
  if (!value) throw new Error('项目 CA Secret 缺少 SecretString');
  const parsed = JSON.parse(value) as Partial<ProjectCaSecret>;
  if (!parsed.caCertificatePem || !parsed.caPrivateKeyPem) {
    throw new Error('项目 CA Secret 必须包含 caCertificatePem 与 caPrivateKeyPem');
  }
  return { caCertificatePem: parsed.caCertificatePem, caPrivateKeyPem: parsed.caPrivateKeyPem };
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
    async issue() {
      const ca = await loadCa();
      const caCertificate = forge.pki.certificateFromPem(ca.caCertificatePem);
      const caPrivateKey = forge.pki.privateKeyFromPem(ca.caPrivateKeyPem);
      const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
      const certificate = forge.pki.createCertificate();
      const now = config.now?.() ?? new Date();

      certificate.publicKey = keyPair.publicKey;
      certificate.serialNumber = positiveSerialNumber();
      certificate.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
      certificate.validity.notAfter = new Date(now.getTime() + config.validitySeconds * 1000);
      certificate.setSubject([{ name: 'commonName', value: `fdp-device-${randomUUID()}` }]);
      certificate.setIssuer(caCertificate.subject.attributes);
      const caSubjectKeyIdentifier = caCertificate.generateSubjectKeyIdentifier().getBytes();
      certificate.setExtensions([
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', clientAuth: true },
        { name: 'subjectKeyIdentifier' },
        { name: 'authorityKeyIdentifier', keyIdentifier: caSubjectKeyIdentifier },
      ]);
      certificate.sign(caPrivateKey, forge.md.sha256.create());

      return {
        certificatePem: forge.pki.certificateToPem(certificate),
        privateKey: forge.pki.privateKeyToPem(keyPair.privateKey),
      };
    },
  };
}
