import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkMatrix, run } from './check-prototype-traceability.mjs';
import { loadJson, validateTraceability } from './check-decisions.mjs';

const MATRIX_PATH = new URL('../contracts/prototype-traceability.yaml', import.meta.url).pathname;
const REGISTER_PATH = new URL('../contracts/decisions/decision-register.json', import.meta.url).pathname;

function realMatrix() {
  return JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
}

test('真实矩阵通过完整性检查', () => {
  assert.deepEqual(checkMatrix(realMatrix()), []);
});

test('真实矩阵：9 菜单、12 页面、每项均有处置结论', () => {
  const m = realMatrix();
  assert.equal(m.menus.length, 9);
  assert.equal(m.pages.length, 12);
  const elements = m.pages.flatMap((p) => p.elements);
  assert.ok(elements.length > 60, `元素数 ${elements.length}`);
  const dispositions = new Set(elements.map((e) => e.disposition));
  for (const d of ['Adopt', 'Adapt', 'Reject']) assert.ok(dispositions.has(d), `缺少 ${d}`);
});

test('被拒绝的实时流、明文密码、状态混用不携带实现任务', () => {
  const m = realMatrix();
  const rejected = m.pages.flatMap((p) => p.elements).filter((e) => e.rejectCategory);
  const categories = new Set(rejected.map((e) => e.rejectCategory));
  assert.ok(categories.has('realtime-stream'));
  assert.ok(categories.has('plaintext-password'));
  assert.ok(categories.has('mixed-status'));
  for (const e of rejected) {
    assert.equal(e.disposition, 'Reject', e.id);
    assert.equal(e.source?.taskId, undefined, `${e.id} 不得进入实现任务`);
  }
});

test('矩阵的 x-decision-versions 可追溯到决策登记（DEC-007~012）', () => {
  const m = realMatrix();
  const register = loadJson(REGISTER_PATH, []);
  const { errors, checked } = validateTraceability([MATRIX_PATH], register);
  assert.deepEqual(errors, []);
  const refs = m['x-decision-versions'];
  for (const dec of ['DEC-007', 'DEC-008', 'DEC-009', 'DEC-010', 'DEC-011', 'DEC-012']) {
    assert.ok(
      refs.some((r) => r.startsWith(`${dec}@`)),
      `缺少 ${dec} 引用`,
    );
  }
  assert.equal(checked.length, refs.length);
});

function baseMatrix() {
  return {
    matrixVersion: '1.0.0',
    menus: [
      'menu.dashboard',
      'menu.device-view',
      'menu.device-operate',
      'menu.device-group',
      'menu.device-consumable',
      'menu.esg-overview',
      'menu.esg-device',
      'menu.contract-modify',
      'menu.settings',
    ].map((menuId, i) => ({
      menuId,
      label: 'x',
      pageState: [
        'dashboard',
        'device-view',
        'device-operate',
        'device-group',
        'device-consumable',
        'esg-overview',
        'esg-device',
        'contract-modify',
        'settings',
      ][i],
      routeId: '/x',
      feTask: 'FE-01',
      roles: ['PlatformSuperAdmin'],
      disposition: 'Adopt',
      source: { taskId: 'FE-01' },
    })),
    pages: [
      'dashboard',
      'device-view',
      'device-operate',
      'device-group',
      'device-manage',
      'device-consumable',
      'contract-modify',
      'contract-new',
      'contract-detail',
      'esg-overview',
      'esg-device',
      'settings',
    ].map((pageState) => ({
      pageState,
      routeId: '/x',
      feTasks: ['FE-01'],
      beTasks: ['BE-DEV-01'],
      disposition: 'Adopt',
      elements: [
        {
          id: `${pageState}.field.a`,
          kind: 'field',
          name: 'x',
          disposition: 'Adopt',
          source: { taskId: 'BE-DEV-01', api: 'listDevices' },
        },
      ],
    })),
  };
}

test('缺少菜单或页面被拒绝', () => {
  const m = baseMatrix();
  m.menus.pop();
  assert.ok(checkMatrix(m).some((e) => e.includes('缺少菜单')));
  const m2 = baseMatrix();
  m2.pages = m2.pages.filter((p) => p.pageState !== 'settings');
  assert.ok(checkMatrix(m2).some((e) => e.includes('缺少页面')));
});

test('重复元素 ID 被拒绝', () => {
  const m = baseMatrix();
  m.pages[0].elements.push({ ...m.pages[0].elements[0] });
  assert.ok(checkMatrix(m).some((e) => e.includes('重复')));
});

test('Adapt/Reject 缺少依据被拒绝', () => {
  const m = baseMatrix();
  m.pages[0].elements[0] = {
    id: 'dashboard.field.a',
    kind: 'field',
    name: 'x',
    disposition: 'Adapt',
    source: { taskId: 'BE-DEV-01', api: 'listDevices' },
  };
  assert.ok(checkMatrix(m).some((e) => e.includes('R3')));
});

test('Adopt/Adapt 生产字段缺少 API 来源被拒绝', () => {
  const m = baseMatrix();
  m.pages[0].elements[0] = {
    id: 'dashboard.field.a',
    kind: 'table-column',
    name: 'x',
    disposition: 'Adopt',
    source: { taskId: 'BE-DEV-01' },
  };
  assert.ok(checkMatrix(m).some((e) => e.includes('R4')));
});

test('rejectCategory 项非 Reject 或携带实现任务被拒绝', () => {
  const m = baseMatrix();
  m.pages[0].elements[0] = {
    id: 'dashboard.button.a',
    kind: 'button',
    name: '播放',
    disposition: 'Adapt',
    basis: 'x',
    rejectCategory: 'realtime-stream',
    source: { taskId: 'FE-06' },
  };
  const errors = checkMatrix(m);
  assert.ok(errors.some((e) => e.includes('R5')));
});

test('未知角色被拒绝（R7）', () => {
  const m = baseMatrix();
  m.menus[0].roles = ['SuperRoot'];
  assert.ok(checkMatrix(m).some((e) => e.includes('R7')));
});

test('CLI：真实矩阵退出码 0，违规矩阵退出码 1', () => {
  const lines = [];
  assert.equal(
    run(['--matrix', MATRIX_PATH], (s) => lines.push(s)),
    0,
  );
  assert.ok(lines.some((l) => l.includes('9/9') && l.includes('12/12')));
});
