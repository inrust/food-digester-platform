/**
 * CT-03 MQTT JSON Schema 契约测试。
 * 运行：node --test "contracts/mqtt/schemas.test.mjs"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry, validate, normalizeEnvelope } from './validator.mjs';
import { computeAuditHash, verifyAuditHash } from './payload-normalization.ts';
import { renderTypes } from '../../scripts/generate-payload-types.mjs';
import { loadJson, validateTraceability } from '../../scripts/check-decisions.mjs';

const SCHEMA_DIR = fileURLToPath(new URL('./schemas/', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const REGISTER_PATH = fileURLToPath(new URL('../decisions/decision-register.json', import.meta.url));

const registry = new SchemaRegistry(SCHEMA_DIR);
const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json') && f !== 'common.schema.json');
const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.fixtures.json'));

function loadSchema(topicType) {
  const fileName = `${topicType}.schema.json`;
  return { schema: registry.load(fileName).doc, fileName };
}

test('11 类消息均有 Schema 和 Fixture，且每类 >=1 合法 + >=3 非法', () => {
  assert.equal(schemaFiles.length, 11);
  assert.equal(fixtureFiles.length, 11);
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8'));
    assert.ok(schemaFiles.includes(`${fixture.topicType}.schema.json`), `${fixture.topicType} 缺少 Schema`);
    assert.ok(fixture.valid.length >= 1, `${fixture.topicType} 合法 Fixture 不足`);
    assert.ok(fixture.invalid.length >= 3, `${fixture.topicType} 非法 Fixture 不足（${fixture.invalid.length}）`);
  }
});

test('所有合法 Fixture 通过校验', () => {
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8'));
    const { schema, fileName } = loadSchema(fixture.topicType);
    fixture.valid.forEach((payload, i) => {
      const errors = validate(schema, fileName, payload, registry);
      assert.deepEqual(errors, [], `${fixture.topicType} valid[${i}] 应通过: ${JSON.stringify(errors)}`);
    });
  }
});

test('所有非法 Fixture 被稳定拒绝并返回明确错误路径', () => {
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8'));
    const { schema, fileName } = loadSchema(fixture.topicType);
    for (const { name, payload, expectPath } of fixture.invalid) {
      const errors = validate(schema, fileName, payload, registry);
      assert.ok(errors.length > 0, `${fixture.topicType} "${name}" 应被拒绝`);
      if (expectPath) {
        assert.ok(
          errors.some((e) => e.path === expectPath || e.path.startsWith(expectPath + '.')),
          `${fixture.topicType} "${name}" 错误路径 ${errors.map((e) => e.path).join(',')} 中应包含 ${expectPath}`,
        );
      }
    }
  }
});

test('非法枚举被稳定拒绝且路径明确', () => {
  const { schema, fileName } = loadSchema('alarm');
  const payload = {
    meta: { id: 'ALM-DEV001-1', ts: '2026-08-01T10:15:00Z', seq: 1 },
    data: { code: 'X', severity: 'SEVERE' },
  };
  const errors = validate(schema, fileName, payload, registry);
  assert.ok(errors.some((e) => e.path === 'data.severity' && e.keyword === 'enum'));
});

test('单位/类型错误被拒绝（integer 不接受小数与字符串）', () => {
  const { schema, fileName } = loadSchema('heartbeat');
  const base = JSON.parse(readFileSync(`${FIXTURE_DIR}/heartbeat.fixtures.json`, 'utf8')).valid[0];
  const bad1 = structuredClone(base);
  bad1.data.uptimeSeconds = 1.5;
  assert.ok(validate(schema, fileName, bad1, registry).some((e) => e.path === 'data.uptimeSeconds'));
  const bad2 = structuredClone(base);
  bad2.data.cpuUsagePct = '25';
  assert.ok(validate(schema, fileName, bad2, registry).some((e) => e.path === 'data.cpuUsagePct'));
});

test('缺少必填字段被拒绝（meta.id、上行 seq、Heartbeat 必填 data 字段）', () => {
  const base = JSON.parse(readFileSync(`${FIXTURE_DIR}/heartbeat.fixtures.json`, 'utf8')).valid[0];
  const { schema, fileName } = loadSchema('heartbeat');

  const noId = structuredClone(base);
  delete noId.meta.id;
  assert.ok(validate(schema, fileName, noId, registry).some((e) => e.path === 'meta' && e.keyword === 'required'));

  const noSeq = structuredClone(base);
  delete noSeq.meta.seq;
  assert.ok(validate(schema, fileName, noSeq, registry).some((e) => e.path === 'meta' && e.message.includes('seq')));

  const noFirmware = structuredClone(base);
  delete noFirmware.data.firmwareVersion;
  assert.ok(
    validate(schema, fileName, noFirmware, registry).some(
      (e) => e.path === 'data' && e.message.includes('firmwareVersion'),
    ),
  );
});

test('额外身份字段（customerId/tenantId/deviceId）在各层均被拒绝', () => {
  const base = JSON.parse(readFileSync(`${FIXTURE_DIR}/telemetry.fixtures.json`, 'utf8')).valid[0];
  const { schema, fileName } = loadSchema('telemetry');

  const inData = structuredClone(base);
  inData.data.customerId = 'CUS-1';
  assert.ok(
    validate(schema, fileName, inData, registry).some((e) => e.path === 'data' && e.keyword === 'additionalProperties'),
  );

  const inMeta = structuredClone(base);
  inMeta.meta.tenantId = 'T-1';
  assert.ok(
    validate(schema, fileName, inMeta, registry).some((e) => e.path === 'meta' && e.keyword === 'additionalProperties'),
  );

  const atRoot = structuredClone(base);
  atRoot.deviceId = 'DEV001';
  assert.ok(
    validate(schema, fileName, atRoot, registry).some(
      (e) => e.path === '(root)' && e.keyword === 'additionalProperties',
    ),
  );
});

test('下行消息 meta.seq 可选（DEC-006），上行强制', () => {
  const cmdValid = JSON.parse(readFileSync(`${FIXTURE_DIR}/cmd.fixtures.json`, 'utf8')).valid[0];
  assert.ok(!('seq' in cmdValid.meta));
  const cmd = loadSchema('cmd');
  assert.deepEqual(validate(cmd.schema, cmd.fileName, cmdValid, registry), []);

  // 下行带 seq 也兼容
  const withSeq = structuredClone(cmdValid);
  withSeq.meta.seq = 1;
  assert.deepEqual(validate(cmd.schema, cmd.fileName, withSeq, registry), []);
});

test('Telemetry/Report/Tamper 强制 audit.hash；Command 禁止 audit（DEC-002）', () => {
  for (const type of ['telemetry', 'report', 'tamper']) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${type}.fixtures.json`, 'utf8'));
    const { schema, fileName } = loadSchema(type);
    const noAudit = structuredClone(fixture.valid[0]);
    delete noAudit.audit;
    assert.ok(
      validate(schema, fileName, noAudit, registry).some((e) => e.path === '(root)' && e.message.includes('audit')),
      `${type} 缺少 audit 应被拒绝`,
    );
  }
});

test('DEC-013：Audited 合法 Fixture 携带可复算的 RFC 8785 audit.hash', () => {
  for (const type of ['telemetry', 'report', 'tamper']) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_DIR}/${type}.fixtures.json`, 'utf8'));
    for (const payload of fixture.valid) {
      assert.equal(verifyAuditHash(payload), true, `${type} audit.hash 必须覆盖 RFC8785({meta,data})`);
      assert.equal(payload.audit.hash, computeAuditHash(payload));
    }
  }
});

test('schemaVer 缺省按 1.0 归一化；非法 schemaVer 被拒绝', () => {
  const base = JSON.parse(readFileSync(`${FIXTURE_DIR}/cmd.fixtures.json`, 'utf8')).valid[0];
  const normalized = normalizeEnvelope(base);
  assert.equal(normalized.meta.schemaVer, '1.0');
  assert.equal(base.meta.schemaVer, undefined, '归一化不得修改原对象');

  const { schema, fileName } = loadSchema('cmd');
  const bad = normalizeEnvelope(base);
  bad.meta.schemaVer = 'v1';
  assert.ok(validate(schema, fileName, bad, registry).some((e) => e.path === 'meta.schemaVer'));

  const good = normalizeEnvelope(base);
  assert.deepEqual(validate(schema, fileName, good, registry), [], 'schemaVer=1.0 应通过');
});

test('meta.id 字符集与长度固定', () => {
  const { schema, fileName } = loadSchema('cmd');
  const base = JSON.parse(readFileSync(`${FIXTURE_DIR}/cmd.fixtures.json`, 'utf8')).valid[0];
  const bad = structuredClone(base);
  bad.meta.id = 'cmd dev 001';
  assert.ok(validate(schema, fileName, bad, registry).some((e) => e.path === 'meta.id'));
});

test('payloads.ts 与 Schema 保持一致（生成器新鲜度）', () => {
  const generated = renderTypes(SCHEMA_DIR);
  const committed = readFileSync(fileURLToPath(new URL('./payloads.ts', import.meta.url)), 'utf8');
  assert.equal(committed, generated, 'payloads.ts 已过期，请运行 node scripts/generate-payload-types.mjs');
});

test('全部 Schema 的 x-decision-versions 可追溯到决策登记', () => {
  const register = loadJson(REGISTER_PATH, []);
  const allSchemas = [...schemaFiles.map((f) => `${SCHEMA_DIR}/${f}`), `${SCHEMA_DIR}/common.schema.json`];
  const { errors, checked } = validateTraceability(allSchemas, register);
  assert.deepEqual(errors, []);
  assert.ok(checked.length >= 12, `至少 12 条追溯引用，实际 ${checked.length}`);
});
