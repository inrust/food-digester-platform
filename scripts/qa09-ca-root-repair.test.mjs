import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { repairCaRoot } from './qa09-ca-root-repair.mjs';
import { X509Certificate } from 'node:crypto';
function ca(name, parent) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = parent ? '02' : '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2036-01-01T00:00:00Z');
  certificate.setSubject([{ name: 'commonName', value: name }]);
  certificate.setIssuer(parent?.certificate.subject.attributes ?? certificate.subject.attributes);
  certificate.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
  certificate.sign(parent?.keys.privateKey ?? keys.privateKey, forge.md.sha256.create());
  return {
    keys,
    certificate,
    pem: forge.pki.certificateToPem(certificate),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
const root = ca('Synthetic Root');
const intermediate = ca('Synthetic Intermediate', root);
const trust = intermediate.pem + root.pem;
const secret = {
  caCertificatePem: intermediate.pem,
  caPrivateKeyPem: intermediate.privateKey,
  caCertificateChainPem: root.pem,
};
const now = new Date('2026-10-02T00:00:00Z');
const baselineVersion = 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9';
const token = 'c1234567-1234-1234-1234-123456789abc';
const rootFingerprint = new X509Certificate(root.pem).fingerprint256;
function setup(options = {}) {
  const original = {
    caCertificatePem: secret.caCertificatePem,
    caPrivateKeyPem: secret.caPrivateKeyPem,
    opaque: { value: 'never-export-canary', arr: [1, false, null] },
  };
  const values = new Map([[baselineVersion, JSON.stringify(original)]]);
  const stages = { [baselineVersion]: ['AWSCURRENT'] };
  const writes = [];
  let moved = false;
  const store = {
    async describe() {
      return { VersionIdsToStages: structuredClone(stages) };
    },
    async get(id) {
      if (!values.has(id)) throw Error('never-export-canary');
      let value = values.get(id);
      if (id === token && moved && options.foreignAfterPromotion) {
        stages[token] = [];
        stages.foreign = ['AWSCURRENT'];
        value = JSON.stringify({ ...JSON.parse(value), opaque: 'never-export-canary-corrupt' });
      }
      if (id === token && (options.badCandidate || (moved && options.badAfterPromote)))
        value = JSON.stringify({ ...JSON.parse(value), opaque: 'never-export-canary-corrupt' });
      return { VersionId: id, SecretString: value };
    },
    async put(input) {
      writes.push('put');
      values.set(input.ClientRequestToken, input.SecretString);
      stages[token] = input.VersionStages;
      if (options.driftAfterPut) {
        stages[baselineVersion] = [];
        stages.foreign = ['AWSCURRENT'];
      }
      if (options.unknownPut) throw Error('never-export-canary');
    },
    async move(input) {
      writes.push('move');
      assert.equal(stages[input.RemoveFromVersionId].includes('AWSCURRENT'), true);
      stages[input.RemoveFromVersionId] = stages[input.RemoveFromVersionId].filter((v) => v !== 'AWSCURRENT');
      stages[input.RemoveFromVersionId].push('AWSPREVIOUS');
      for (const list of Object.values(stages)) {
        const i = list.indexOf('AWSPREVIOUS');
        if (i >= 0 && list !== stages[input.RemoveFromVersionId]) list.splice(i, 1);
      }
      stages[input.MoveToVersionId] = ['AWSCURRENT'];
      moved = true;
      if (options.unknownPromotion && input.MoveToVersionId === token) throw Error('never-export-canary');
    },
  };
  const run = (extra = {}) =>
    repairCaRoot({ store, baselineVersion, token, truststorePem: trust, rootFingerprint, now, ...extra });
  return { run, values, stages, writes, original, store };
}
test('only root field changes, original version remains immutable and AWSPREVIOUS', async () => {
  const f = setup();
  const r = await f.run();
  assert.equal(r.completed, true);
  assert.equal(r.otherFieldsUnchanged, true);
  assert.equal(r.originalVersionRetained, true);
  assert.deepEqual(JSON.parse(f.values.get(baselineVersion)), f.original);
  assert.deepEqual(JSON.parse(f.values.get(token)), {
    ...f.original,
    caCertificateChainPem: root.pem.trim() + '\n',
  });
  assert.deepEqual(f.stages[baselineVersion], ['AWSPREVIOUS']);
  assert.ok(!JSON.stringify(r).includes('never-export-canary'));
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));
});
test('baseline drift prevents all writes', async () => {
  const f = setup();
  f.stages[baselineVersion] = [];
  f.stages.foreign = ['AWSCURRENT'];
  assert.equal((await f.run()).errorCode, 'BASELINE_DRIFT');
  assert.deepEqual(f.writes, []);
});
test('wrong fixed root prevents all writes', async () => {
  const f = setup();
  assert.equal((await f.run({ rootFingerprint: 'WRONG' })).errorCode, 'BASELINE_CHAIN_DRIFT');
  assert.deepEqual(f.writes, []);
});
test('unknown put outcome recovers immutable token without a second put', async () => {
  const f = setup({ unknownPut: true });
  assert.equal((await f.run()).completed, true);
  assert.deepEqual(f.writes, ['put', 'move']);
});
test('candidate mutation fails before promotion', async () => {
  const f = setup({ badCandidate: true });
  const r = await f.run();
  assert.equal(r.errorCode, 'OTHER_FIELDS_CHANGED');
  assert.equal(r.promoted, false);
  assert.deepEqual(f.writes, ['put']);
});
test('concurrent current movement after candidate write is preserved', async () => {
  const f = setup({ driftAfterPut: true });
  assert.equal((await f.run()).errorCode, 'BASELINE_DRIFT');
  assert.deepEqual(f.writes, ['put']);
  assert.deepEqual(f.stages.foreign, ['AWSCURRENT']);
});
test('unknown promotion response is recovered from current stages', async () => {
  const f = setup({ unknownPromotion: true });
  assert.equal((await f.run()).completed, true);
  assert.deepEqual(f.writes, ['put', 'move']);
});
test('post-promotion failed readback rolls back only the known current candidate', async () => {
  const f = setup({ badAfterPromote: true });
  const r = await f.run();
  assert.equal(r.completed, false);
  assert.equal(r.rolledBack, true);
  assert.deepEqual(f.stages[baselineVersion], ['AWSCURRENT']);
  assert.deepEqual(f.writes, ['put', 'move', 'move']);
});
test('invalid version token rejects before accessing any secret', async () => {
  const f = setup();
  await assert.rejects(f.run({ token: 'bad' }), /INVALID_VERSION/);
  assert.deepEqual(f.writes, []);
});

test('rollback refuses to overwrite a concurrent foreign current version', async () => {
  const f = setup({ foreignAfterPromotion: true });
  const r = await f.run();
  assert.equal(r.completed, false);
  assert.equal(r.rolledBack, false);
  assert.equal(r.rollbackNeedsReview, true);
  assert.deepEqual(f.stages.foreign, ['AWSCURRENT']);
  assert.deepEqual(f.writes, ['put', 'move']);
});
test('unknown AWS errors are returned as fixed codes without secret exception text', async () => {
  const f = setup();
  const r = await f.run({
    store: {
      describe: async () => {
        throw Error('never-export-canary');
      },
    },
  });
  assert.equal(r.errorCode, 'AWS_REPAIR_FAILED');
  assert.ok(!JSON.stringify(r).includes('never-export-canary'));
});

test('successful promotion waits for metadata visibility without repeating stage writes', async () => {
  const f = setup();
  const describe = f.store.describe;
  let staleReads = 0,
    waits = 0;
  f.store.describe = async () => {
    if (f.writes.includes('move') && staleReads++ < 2)
      return { VersionIdsToStages: { [baselineVersion]: ['AWSCURRENT'], [token]: ['CANDIDATE'] } };
    return describe();
  };
  const r = await f.run({
    pause: async () => {
      waits++;
    },
  });
  assert.equal(r.completed, true);
  assert.equal(waits, 2);
  assert.deepEqual(f.writes, ['put', 'move']);
});
test('existing current candidate is verified using read-only store without new versions or stage writes', async () => {
  const f = setup();
  f.values.set(token, JSON.stringify({ ...f.original, caCertificateChainPem: root.pem.trim() + '\n' }));
  f.stages[baselineVersion] = ['AWSPREVIOUS'];
  f.stages[token] = ['AWSCURRENT'];
  const r = await f.run({ store: { describe: f.store.describe, get: f.store.get } });
  assert.equal(r.completed, true);
  assert.equal(r.resumedCurrentVersion, true);
  assert.deepEqual(f.writes, []);
  assert.equal(f.values.size, 2);
});
test('read-only recovery rejects changed fields without rolling back an existing current version', async () => {
  const f = setup();
  f.values.set(
    token,
    JSON.stringify({ ...f.original, opaque: 'changed', caCertificateChainPem: root.pem.trim() + '\n' }),
  );
  f.stages[baselineVersion] = ['AWSPREVIOUS'];
  f.stages[token] = ['AWSCURRENT'];
  const r = await f.run({ store: { describe: f.store.describe, get: f.store.get } });
  assert.equal(r.errorCode, 'OTHER_FIELDS_CHANGED');
  assert.equal(r.completed, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.stages[token], ['AWSCURRENT']);
});
