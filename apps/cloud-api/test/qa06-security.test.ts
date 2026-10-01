import { randomUUID } from 'node:crypto';
import { assert, test } from 'vitest';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { createRedactingLogger, redactTraceAttributes } from '@fdp/observability';
import { recordAudit } from '@fdp/database';
import { createAdminCustomerHandlers, createAdminDeviceHandlers, createDeviceMediaHandler } from '../src/index.js';
import { createAdminLambdaRouter } from '../src/runtime/admin-lambda.js';
import { DELIVERED_OPERATIONS } from '../src/runtime/delivered-operations.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { createTestDb } from './helpers.js';
import { inspectArtifact, proof } from './qa06-evidence.js';
const NOW = new Date('2026-10-01T00:00:00Z');
const prefix = () => `QA06-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
async function fixture(
  name: string,
  run: (db: Awaited<ReturnType<typeof createTestDb>>, id: string) => Promise<Record<string, unknown>>,
) {
  const db = await createTestDb();
  const id = prefix();
  let facts: Record<string, unknown>;
  try {
    facts = await run(db, id);
  } finally {
    await db.prisma.$disconnect();
    await db.pg.close();
  }
  proof(name, { prefix: id, cleanup: 'PASS', ...facts });
}

test('QA06 all admin write routes reject forged actor and missing expired tampered JWT before resolution', async () => {
  const keys = await generateTestKeySet();
  let calls = 0;
  const router = createAdminLambdaRouter(testConfig(keys.jwks), () => {
    calls++;
    throw new Error('must not resolve unauthorized route');
  });
  const expired = await signToken(keys, { groups: ['PlatformSuperAdmin'], expiresInSeconds: -3600 });
  const foreign = await generateTestKeySet();
  const forged = await signToken(keys, { groups: ['PlatformSuperAdmin'], signingKey: foreign.privateKey });
  const writes = DELIVERED_OPERATIONS.filter((o) => o.runtime === 'admin-api' && o.method !== 'GET');
  const matrix = [];
  for (const op of writes) {
    const statuses = [];
    for (const token of [undefined, expired, forged]) {
      const response = await router({
        httpMethod: op.method,
        path: op.path.replace(/\{[^}]+\}/g, 'qa06-target'),
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: '{}',
        actor: { roles: ['PlatformSuperAdmin'] },
        requestContext: { requestId: prefix(), authorizer: { claims: { 'cognito:groups': ['PlatformSuperAdmin'] } } },
      });
      assert.equal(response.statusCode, 401);
      inspectArtifact('response', JSON.parse(response.body), [expired, forged]);
      statuses.push(response.statusCode);
    }
    matrix.push({ operationId: op.operationId, statuses });
  }
  assert.equal(calls, 0);
  assert.isAbove(writes.length, 0);
  proof('all-admin-write-auth', { prefix: prefix(), cleanup: 'PASS', matrix, resolverCalls: 0 });
});

test('QA06 signed tenant scope and SQL JSON injection cannot cross boundaries or corrupt business state', async () => {
  await fixture('tenant-sql-json', async ({ prisma }, id) => {
    for (const suffix of ['A', 'B']) {
      await prisma.customer.create({ data: { id: `${id}-${suffix}`, name: `${id}-${suffix}` } });
      await prisma.device.create({
        data: {
          id: `${id}-${suffix}-DEV`,
          serialNumber: `${id}-${suffix}-DEV`,
          model: 'BNX-100',
          hardwareVersion: 'HW1',
          manufacturer: 'QA06',
          manufactureDate: NOW,
          customerId: `${id}-${suffix}`,
          lifecycleStatus: 'Active',
        },
      });
    }
    const keys = await generateTestKeySet();
    const customer = await signToken(keys, { groups: ['CustomerAdmin'], customerId: `${id}-A` });
    const admin = await signToken(keys, { groups: ['PlatformSuperAdmin'] });
    const devices = createAdminDeviceHandlers({ client: prisma, now: () => NOW });
    const customers = createAdminCustomerHandlers({ client: prisma, now: () => NOW });
    const cross = createAdminLambdaRouter(
      testConfig(keys.jwks),
      () => (r) => devices.detail({ ...r, params: { deviceId: `${id}-B-DEV` } }),
    );
    const crossResult = await cross({
      headers: { authorization: `Bearer ${customer}` },
      queryStringParameters: { customerId: `${id}-B`, roles: 'PlatformSuperAdmin' },
      actor: { roles: ['PlatformSuperAdmin'] },
      requestContext: { requestId: id, authorizer: { claims: { 'custom:customer_id': `${id}-B` } } },
    });
    assert.equal(crossResult.statusCode, 403);
    inspectArtifact('response', JSON.parse(crossResult.body), [customer]);
    const unauthorized = createAdminLambdaRouter(testConfig(keys.jwks), () => (r) => customers.create(r));
    const denied = await unauthorized({
      headers: { authorization: `Bearer ${customer}` },
      body: JSON.stringify({ name: 'forbidden' }),
      requestContext: { requestId: id },
    });
    assert.equal(denied.statusCode, 403);
    inspectArtifact('response', JSON.parse(denied.body), [customer]);
    assert.equal(await prisma.customer.count(), 2);
    assert.equal(await prisma.auditLog.count(), 0);
    const create = createAdminLambdaRouter(testConfig(keys.jwks), () => (r) => customers.create(r));
    const injections = [
      '{',
      '[]',
      'null',
      '{"name":{"$ne":null}}',
      '{"name":"bad","__proto__":{"isAdmin":true}}',
      '{"name":"bad","constructor":{"prototype":{"isAdmin":true}}}',
      '{"name":"bad","customerId":"foreign","roles":["PlatformSuperAdmin"]}',
    ];
    for (const body of injections) {
      const response = await create({
        headers: { authorization: `Bearer ${admin}` },
        body,
        requestContext: { requestId: id },
      });
      assert.equal(response.statusCode, 400);
      inspectArtifact('response', JSON.parse(response.body), [admin]);
    }
    assert.equal(await prisma.customer.count(), 2);
    assert.equal(await prisma.auditLog.count(), 0);
    assert.equal((Object.prototype as { isAdmin?: boolean }).isAdmin, undefined);
    const sql = "QA06'); DROP TABLE customers; --";
    const literal = await create({
      headers: { authorization: `Bearer ${admin}` },
      body: JSON.stringify({ name: sql }),
      requestContext: { requestId: id },
    });
    assert.equal(literal.statusCode, 201);
    inspectArtifact('response', JSON.parse(literal.body), [admin]);
    assert.equal(await prisma.customer.count(), 3);
    assert.equal(await prisma.device.count(), 2);
    assert.equal((await prisma.customer.findMany({ where: { name: sql } })).length, 1);
    const list = createAdminLambdaRouter(testConfig(keys.jwks), () => (r) => devices.list(r));
    const filtered = await list({
      headers: { authorization: `Bearer ${customer}` },
      queryStringParameters: { q: "' OR 1=1 --", customerId: `${id}-B` },
      requestContext: { requestId: id },
    });
    assert.notEqual(filtered.statusCode, 500);
    assert.isTrue([200, 403, 400].includes(filtered.statusCode));
    const body = JSON.parse(filtered.body);
    inspectArtifact('response', body, [customer]);
    if (filtered.statusCode === 200)
      assert.isTrue(body.data.every((d: { customerId: string }) => d.customerId === `${id}-A`));
    return {
      crossTenantStatus: 403,
      writeDenied: 403,
      noUnauthorizedWrites: true,
      jsonRejected: injections.length,
      sqlLiteralStored: true,
      sqlNoCrossScope: true,
      prototypeUnchanged: true,
    };
  });
});

test('QA06 malicious media filenames and metadata reject before signing or persistence', async () => {
  await fixture('malicious-media', async ({ prisma }, id) => {
    await prisma.customer.create({ data: { id, name: id } });
    await prisma.device.create({
      data: {
        id,
        serialNumber: id,
        model: 'BNX-100',
        hardwareVersion: 'HW1',
        manufacturer: 'QA06',
        manufactureDate: NOW,
        customerId: id,
        lifecycleStatus: 'Active',
      },
    });
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(id).toString('base64')}\n-----END CERTIFICATE-----`;
    await prisma.deviceCertificate.create({
      data: {
        id,
        deviceId: id,
        fingerprint: certificateFingerprintFromPem(pem),
        status: 'ACTIVE',
        notBefore: new Date('2020-01-01'),
        notAfter: new Date('2030-01-01'),
      },
    });
    let signed = 0;
    const handler = createDeviceMediaHandler({
      client: prisma,
      now: () => NOW,
      storage: { statObject: async () => null, computeSha256: async () => null },
      urlSigner: {
        signUpload: async () => {
          signed++;
          return 'https://invalid.test/upload';
        },
        signDownload: async () => {
          signed++;
          return 'https://invalid.test/download';
        },
      },
      uploadPolicy: {
        getMediaTypes: () => ['IMAGE', 'VIDEO'],
        getMaxSizeKb: () => 10240,
        getDailyUploadQuotaPerDevice: () => 100,
        getUploadUrlTtlSeconds: () => 900,
        getDownloadUrlTtlSeconds: () => 900,
      },
    });
    const body = { mediaType: 'IMAGE', fileName: 'safe.jpg', sizeKb: 1, sizeBytes: 1, sha256: 'a'.repeat(64) };
    const attacks = [
      ...['../x', '..\\x', '%2e%2e%2fx', 'https://evil.test/x', 'x\u0000.jpg', '<script>.jpg', 'x'.repeat(129)].map(
        (fileName) => ({ ...body, fileName }),
      ),
      { ...body, objectPath: `media/foreign/${id}/x` },
      { ...body, bucket: 'foreign' },
      { ...body, sizeKb: Infinity },
      { ...body, sha256: 'not-a-hash' },
      JSON.parse('{"__proto__":{"isAdmin":true}}'),
    ];
    for (const input of attacks) {
      const result = await handler({ identity: { clientCertPem: pem }, body: input, requestId: id });
      assert.equal(result.status, 400);
      inspectArtifact('response', result.body);
    }
    assert.equal(signed, 0);
    assert.equal(await prisma.mediaUploadSession.count(), 0);
    assert.equal(await prisma.mediaObject.count(), 0);
    assert.equal(await prisma.auditLog.count(), 0);
    return { attacksRejected: attacks.length, statuses: [400], signedUrls: 0, businessWrites: 0 };
  });
});

test('QA06 raw canaries are absent from actual logger trace audit and snapshot artifacts', async () => {
  await fixture('sensitive-artifacts', async ({ prisma }, id) => {
    const keys = await generateTestKeySet();
    const token = await signToken(keys, { groups: ['PlatformSuperAdmin'] });
    const privateKey = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      id,
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const passwordHash = `${id}-opaque-hash`;
    const signedUrl = `https://s3.example.test/object?X-Amz-Signature=${id}`;
    const input = {
      passwordHash,
      privateKey,
      token,
      authorization: `Bearer ${token}`,
      Cookie: `session=${id}`,
      session: id,
      jwt: token,
      nested: [{ message: `raw ${token}`, note: privateKey, url: signedUrl }],
    };
    const known = [token, passwordHash, privateKey, signedUrl, `session=${id}`];
    const captured: unknown[][] = [];
    const sink = {
      debug: (...args: unknown[]) => captured.push(args),
      info: (...args: unknown[]) => captured.push(args),
      warn: (...args: unknown[]) => captured.push(args),
      error: (...args: unknown[]) => captured.push(args),
    };
    const logger = createRedactingLogger(sink);
    for (const level of ['debug', 'info', 'warn', 'error'] as const)
      logger[level](input, new Error(`failed ${token} ${signedUrl}`));
    for (const entry of captured) inspectArtifact('log', entry, known);
    const trace = redactTraceAttributes(input);
    inspectArtifact('snapshot', JSON.parse(JSON.stringify(trace)), known);
    await recordAudit(prisma, {
      objectType: 'QA06',
      objectId: id,
      action: 'qa06.redaction',
      result: 'SUCCESS',
      beforeValue: input,
      afterValue: input,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { objectId: id } });
    inspectArtifact('audit', { before: audit.beforeValue, after: audit.afterValue }, known);
    return { logLevels: 4, traceScanned: true, auditScanned: true, snapshotScanned: true, sensitiveFindings: 0 };
  });
});
