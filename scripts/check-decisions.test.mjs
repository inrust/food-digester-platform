import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJson, validateRegister, validateContractVersion, validateTraceability, run } from './check-decisions.mjs';

const REGISTER_PATH = new URL('../contracts/decisions/decision-register.json', import.meta.url).pathname;
const CONTRACT_VERSION_PATH = new URL('../contracts/contract-version.json', import.meta.url).pathname;

function realRegister() {
  return JSON.parse(JSON.stringify(loadJson(REGISTER_PATH, [])));
}

function makeDecision(overrides = {}) {
  return {
    id: 'DEC-001',
    version: '0.1.0',
    status: 'pending',
    title: '测试决策',
    conflict: '测试冲突',
    provisionalValue: '暂定值',
    approver: null,
    approvedAt: null,
    blockingTasks: ['CT-03'],
    affectedModules: ['CT'],
    sourceRefs: ['device-cloud-communication-design'],
    history: [{ version: '0.1.0', at: '2026-08-26T00:00:00Z', by: 'CT-01', note: '登记' }],
    ...overrides,
  };
}

function makeRegister(decisions, overrides = {}) {
  return {
    registerVersion: '1.0.0',
    updatedAt: '2026-08-26T00:00:00Z',
    sourceDocuments: [{ tier: 1, id: 'device-cloud-communication-design', file: 'docs/x.pdf', title: 'PDF' }],
    principles: [
      {
        id: 'PRI-001',
        version: '1.0.0',
        status: 'active',
        title: '原则',
        statement: '原则内容',
        approvedBy: 'CT-01',
        affectedModules: ['all'],
        history: [{ version: '1.0.0', at: '2026-08-26T00:00:00Z', by: 'CT-01', note: '登记' }],
      },
    ],
    decisions,
    ...overrides,
  };
}

test('真实登记文件：结构校验通过，并准确识别当前未决 DEC', () => {
  const register = realRegister();
  const { errors, pending } = validateRegister(register, REGISTER_PATH);
  assert.deepEqual(errors, []);
  assert.equal(register.decisions.length, 22);
  assert.equal(register.principles.length, 3);
  const expectedPendingIds = register.decisions.filter((decision) => decision.status === 'pending').map((d) => d.id);
  assert.deepEqual(
    pending.map((p) => p.id),
    expectedPendingIds,
  );
  // 每条未决决策必须携带阻塞任务，保证可追溯
  for (const p of pending) {
    assert.ok(p.blockingTasks.length > 0, `${p.id} 缺少 blockingTasks`);
  }
});

test('真实契约版本文件：decisionRegisterVersion 与登记一致', () => {
  const register = realRegister();
  const contractVersion = loadJson(CONTRACT_VERSION_PATH, []);
  assert.deepEqual(validateContractVersion(contractVersion, register), []);
});

test('契约版本不一致被拒绝', () => {
  const register = realRegister();
  const errors = validateContractVersion({ contractVersion: '0.1.0', decisionRegisterVersion: '9.9.9' }, register);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /不一致/);
});

test('重复决策 ID 被拒绝（已知冲突必须有唯一决策 ID）', () => {
  const register = makeRegister([makeDecision(), makeDecision({ id: 'DEC-001', title: '重复' })]);
  const { errors } = validateRegister(register);
  assert.ok(errors.some((e) => e.includes('重复')));
});

test('原则与决策之间 ID 也全局唯一', () => {
  const register = makeRegister([makeDecision({ id: 'DEC-001' })]);
  register.principles[0].id = 'PRI-001';
  register.decisions.push(makeDecision({ id: 'DEC-002' }));
  const dup = makeRegister([makeDecision({ id: 'DEC-001' })]);
  dup.decisions.push(makeDecision({ id: 'DEC-001' }));
  assert.ok(validateRegister(dup).errors.some((e) => e.includes('重复')));
  assert.deepEqual(validateRegister(register).errors, []);
});

test('pending 决策携带批准人被拒绝', () => {
  const register = makeRegister([makeDecision({ approver: '某人' })]);
  const { errors } = validateRegister(register);
  assert.ok(errors.some((e) => e.includes('approver')));
});

test('frozen 决策必须有批准人、批准时间和 >=1.0.0 版本', () => {
  const bad1 = makeRegister([makeDecision({ status: 'frozen', version: '1.0.0' })]);
  assert.ok(validateRegister(bad1).errors.some((e) => e.includes('approver')));

  const bad2 = makeRegister([
    makeDecision({ status: 'frozen', version: '0.1.0', approver: '业务方', approvedAt: '2026-08-26T00:00:00Z' }),
  ]);
  assert.ok(validateRegister(bad2).errors.some((e) => e.includes('>= 1.0.0')));

  const good = makeRegister([
    makeDecision({
      status: 'frozen',
      version: '1.0.0',
      approver: '业务方',
      approvedAt: '2026-08-26T00:00:00Z',
      history: [{ version: '1.0.0', at: '2026-08-26T00:00:00Z', by: '业务方', note: '冻结' }],
    }),
  ]);
  const { errors, pending } = validateRegister(good);
  assert.deepEqual(errors, []);
  assert.equal(pending.length, 0);
});

test('blockingTasks 为空或格式非法被拒绝', () => {
  const empty = makeRegister([makeDecision({ blockingTasks: [] })]);
  assert.ok(validateRegister(empty).errors.some((e) => e.includes('blockingTasks')));
  const badFormat = makeRegister([makeDecision({ blockingTasks: ['not-a-task'] })]);
  assert.ok(validateRegister(badFormat).errors.some((e) => e.includes('blockingTasks')));
});

test('history 必须非空且末条版本与条目版本一致', () => {
  const noHistory = makeRegister([makeDecision({ history: [] })]);
  assert.ok(validateRegister(noHistory).errors.some((e) => e.includes('history')));
  const mismatch = makeRegister([
    makeDecision({
      version: '0.2.0',
      history: [{ version: '0.1.0', at: '2026-08-26T00:00:00Z', by: 'CT-01', note: 'x' }],
    }),
  ]);
  assert.ok(validateRegister(mismatch).errors.some((e) => e.includes('不一致')));
});

test('非 UTC 时间戳被拒绝', () => {
  const bad = makeRegister([makeDecision()]);
  bad.updatedAt = '2026-08-26 08:00:00';
  assert.ok(validateRegister(bad).errors.some((e) => e.includes('updatedAt')));
});

test('CLI validate 模式：真实文件退出码 0 且输出实际未决数；--fail-on-pending 按实际未决数返回', () => {
  const lines = [];
  const log = (s) => lines.push(s);
  const code = run(['--register', REGISTER_PATH, '--contract-version', CONTRACT_VERSION_PATH], log);
  assert.equal(code, 0);
  const pendingCount = realRegister().decisions.filter((decision) => decision.status === 'pending').length;
  const pendingSummary = pendingCount > 0 ? `未决决策（${pendingCount} 条）` : '未决决策: 0';
  assert.ok(lines.some((line) => line.includes(pendingSummary)));

  const code2 = run(
    ['--register', REGISTER_PATH, '--contract-version', CONTRACT_VERSION_PATH, '--fail-on-pending', '--json'],
    () => {},
  );
  assert.equal(code2, pendingCount > 0 ? 2 : 0);
});

test('CLI：结构错误退出码 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-test-'));
  try {
    const badRegister = join(dir, 'register.json');
    writeFileSync(badRegister, JSON.stringify(makeRegister([makeDecision(), makeDecision()])));
    const cv = join(dir, 'cv.json');
    writeFileSync(cv, JSON.stringify({ contractVersion: '0.1.0', decisionRegisterVersion: '1.0.0' }));
    const code = run(['--register', badRegister, '--contract-version', cv, '--json'], () => {});
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withTraceFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dec-trace-'));
  try {
    const paths = [];
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(content));
      paths.push(p);
    }
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('追溯校验：合法 x-decision-versions 引用通过（Schema 可追溯到决策版本）', () => {
  const register = realRegister();
  const dec002 = register.decisions.find((d) => d.id === 'DEC-002');
  withTraceFixture(
    {
      'command.schema.json': {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        'x-decision-versions': [`DEC-002@${dec002.version}`, 'ADP-002@1.0.0'],
        type: 'object',
      },
    },
    ([file]) => {
      const { errors, checked } = validateTraceability([file], register);
      assert.deepEqual(errors, []);
      assert.equal(checked.length, 2);
    },
  );
});

test('追溯校验：不存在的决策 ID 被拒绝', () => {
  const register = realRegister();
  withTraceFixture({ 'bad.schema.json': { 'x-decision-versions': ['DEC-999@1.0.0'] } }, ([file]) => {
    const { errors } = validateTraceability([file], register);
    assert.ok(errors.some((e) => e.includes('不存在')));
  });
});

test('追溯校验：引用版本与登记版本不一致被拒绝', () => {
  const register = realRegister();
  withTraceFixture({ 'stale.schema.json': { 'x-decision-versions': ['DEC-002@9.9.9'] } }, ([file]) => {
    const { errors } = validateTraceability([file], register);
    assert.ok(errors.some((e) => e.includes('不一致')));
  });
});

test('追溯校验：缺少 x-decision-versions 或格式非法被拒绝', () => {
  const register = realRegister();
  withTraceFixture(
    {
      'missing.schema.json': { type: 'object' },
      'malformed.schema.json': { 'x-decision-versions': ['DEC-002'] },
    },
    ([missing, malformed]) => {
      assert.ok(validateTraceability([missing], register).errors.some((e) => e.includes('未找到')));
      assert.ok(validateTraceability([malformed], register).errors.some((e) => e.includes('格式必须为')));
    },
  );
});

test('追溯校验：嵌套在 OpenAPI info 下的 x-decision-versions 可被递归发现', () => {
  const register = realRegister();
  const dec006 = register.decisions.find((d) => d.id === 'DEC-006');
  withTraceFixture(
    {
      'openapi.json': {
        openapi: '3.1.0',
        info: { title: 'x', version: '0.1.0', 'x-decision-versions': [`DEC-006@${dec006.version}`] },
        paths: {},
      },
    },
    ([file]) => {
      const { errors, checked } = validateTraceability([file], register);
      assert.deepEqual(errors, []);
      assert.equal(checked.length, 1);
    },
  );
});
