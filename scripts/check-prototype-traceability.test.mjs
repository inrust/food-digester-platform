import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkMatrix,
  loadOperationIndex,
  loadReferenceIndex,
  loadRouteIndex,
  loadSourceIndex,
  run,
} from './check-prototype-traceability.mjs';
import { loadJson, validateTraceability } from './check-decisions.mjs';

const MATRIX_PATH = new URL('../contracts/prototype-traceability.yaml', import.meta.url).pathname;
const REGISTER_PATH = new URL('../contracts/decisions/decision-register.json', import.meta.url).pathname;
const REST_DIR = new URL('../contracts/rest/', import.meta.url).pathname;
const ROUTE_REGISTRY_PATH = new URL('../contracts/prototype-route-registry.json', import.meta.url).pathname;
const SOURCE_INVENTORY_PATH = new URL('../contracts/prototype-source-elements.json', import.meta.url).pathname;
const PROTOTYPE_PATH = new URL('../docs/index19.html', import.meta.url).pathname;
const REAL_REFERENCES = loadReferenceIndex(REST_DIR, ROUTE_REGISTRY_PATH, SOURCE_INVENTORY_PATH, PROTOTYPE_PATH);

function realMatrix() {
  return JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
}

test('真实矩阵通过完整性检查', () => {
  assert.deepEqual(checkMatrix(realMatrix(), REAL_REFERENCES), []);
});

test('真实引用集合：41 个矩阵 API 与 13 个 routeId 全部可解析', () => {
  const m = realMatrix();
  const apiRefs = new Set(m.pages.flatMap((p) => p.elements.map((e) => e.source?.api).filter(Boolean)));
  const routeRefs = new Set([
    ...m.menus.map((menu) => menu.routeId),
    ...m.pages.map((page) => page.routeId),
    ...m.pages.flatMap((page) => page.elements.map((e) => e.source?.routeId).filter(Boolean)),
  ]);
  assert.equal(apiRefs.size, 41);
  assert.equal(routeRefs.size, 13);
  for (const operationId of apiRefs) assert.ok(REAL_REFERENCES.operations.has(operationId), operationId);
  for (const routeId of routeRefs) assert.ok(REAL_REFERENCES.routes.has(routeId), routeId);
});

test('index19.html 源清单：9 个菜单、12 个页面、128 个元素与矩阵双向覆盖', () => {
  assert.deepEqual(REAL_REFERENCES.source.errors, []);
  assert.equal(REAL_REFERENCES.source.menus.size, 9);
  assert.equal(REAL_REFERENCES.source.pages.size, 12);
  assert.equal(REAL_REFERENCES.source.elements.size, 128);
  const matrixIds = new Set(realMatrix().pages.flatMap((page) => page.elements.map((element) => element.id)));
  assert.deepEqual(new Set(REAL_REFERENCES.source.elements.keys()), matrixIds);
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
  const pageStates = [
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
  ];
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
    ].map((menuId, i) => {
      const pageState = [
        'dashboard',
        'device-view',
        'device-operate',
        'device-group',
        'device-consumable',
        'esg-overview',
        'esg-device',
        'contract-modify',
        'settings',
      ][i];
      return {
        menuId,
        label: 'x',
        pageState,
        routeId: `/${pageState}`,
        feTask: 'FE-01',
        roles: ['PlatformSuperAdmin'],
        disposition: 'Adopt',
        source: { taskId: 'FE-01' },
      };
    }),
    pages: pageStates.map((pageState) => ({
      pageState,
      routeId: `/${pageState}`,
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

function fixtureReferences(matrix) {
  const routes = new Map();
  for (const page of matrix.pages) routes.set(page.routeId, { routeId: page.routeId, pageState: page.pageState });
  for (const menu of matrix.menus) {
    if (!routes.has(menu.routeId)) routes.set(menu.routeId, { routeId: menu.routeId, pageState: menu.pageState });
  }
  return {
    operations: new Map([
      [
        'listDevices',
        { id: 'listDevices', status: 'implemented', taskId: null, fields: new Set(['a']), file: 'fixture' },
      ],
    ]),
    routes,
    errors: [],
  };
}

function checkFixture(matrix) {
  return checkMatrix(matrix, fixtureReferences(matrix));
}

test('缺少菜单或页面被拒绝', () => {
  const m = baseMatrix();
  m.menus.pop();
  assert.ok(checkFixture(m).some((e) => e.includes('缺少菜单')));
  const m2 = baseMatrix();
  m2.pages = m2.pages.filter((p) => p.pageState !== 'settings');
  assert.ok(checkFixture(m2).some((e) => e.includes('缺少页面')));
});

test('重复元素 ID 被拒绝', () => {
  const m = baseMatrix();
  m.pages[0].elements.push({ ...m.pages[0].elements[0] });
  assert.ok(checkFixture(m).some((e) => e.includes('重复')));
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
  assert.ok(checkFixture(m).some((e) => e.includes('R3')));
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
  assert.ok(checkFixture(m).some((e) => e.includes('R4')));
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
  const errors = checkFixture(m);
  assert.ok(errors.some((e) => e.includes('R5')));
});

test('未知角色被拒绝（R7）', () => {
  const m = baseMatrix();
  m.menus[0].roles = ['SuperRoot'];
  assert.ok(checkFixture(m).some((e) => e.includes('R7')));
});

test('格式合法但不存在的 operationId、routeId 与响应字段被拒绝', () => {
  const missingOperation = realMatrix();
  missingOperation.pages[0].elements[0].source.api = 'definitelyMissingOperation';
  assert.ok(checkMatrix(missingOperation, REAL_REFERENCES).some((e) => e.includes('未在 OpenAPI 中声明')));

  const missingRoute = realMatrix();
  missingRoute.pages[0].routeId = '/definitely-missing-route';
  assert.ok(checkMatrix(missingRoute, REAL_REFERENCES).some((e) => e.includes('未在路由登记中声明')));

  const missingField = realMatrix();
  missingField.pages[0].elements[0].source.field = 'definitelyMissingField';
  assert.ok(checkMatrix(missingField, REAL_REFERENCES).some((e) => e.includes('不存在于 getDashboardSummary')));
});

test('planned operation 的任务归属漂移被拒绝', () => {
  const m = realMatrix();
  m.pages[0].elements[0].source.taskId = 'BE-DEV-01';
  assert.ok(checkMatrix(m, REAL_REFERENCES).some((e) => e.includes('planned operation getDashboardSummary 属于')));
});

test('源清单与矩阵任一侧删除元素均被双向覆盖检查拒绝', () => {
  const missingFromMatrix = realMatrix();
  const removedId = missingFromMatrix.pages[0].elements.pop().id;
  assert.ok(
    checkMatrix(missingFromMatrix, REAL_REFERENCES).some(
      (error) => error.includes(removedId) && error.includes('未映射到矩阵'),
    ),
  );

  const root = mkdtempSync(join(tmpdir(), 'fdp-prototype-source-'));
  const inventory = JSON.parse(readFileSync(SOURCE_INVENTORY_PATH, 'utf8'));
  const missingFromInventory = inventory.pages[0].elements.pop();
  const inventoryPath = join(root, 'source-elements.json');
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const source = loadSourceIndex(inventoryPath, PROTOTYPE_PATH);
  const references = { ...REAL_REFERENCES, source, errors: source.errors };
  assert.ok(
    checkMatrix(realMatrix(), references).some(
      (error) => error.includes(missingFromInventory) && error.includes('未登记到'),
    ),
  );
});

test('index19.html 内容变化但未重新盘点源清单时失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-prototype-html-'));
  const prototypePath = join(root, 'index19.html');
  writeFileSync(prototypePath, `${readFileSync(PROTOTYPE_PATH, 'utf8')}\n<!-- drift -->\n`);
  const source = loadSourceIndex(SOURCE_INVENTORY_PATH, prototypePath);
  assert.ok(source.errors.some((error) => error.includes('SHA-256') && error.includes('R10')));
});

test('重复 operationId 与 routeId 被引用索引拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-prototype-refs-'));
  const restDir = join(root, 'rest');
  mkdirSync(restDir);
  writeFileSync(join(restDir, 'openapi-base.json'), JSON.stringify({ openapi: '3.1.0', info: {}, paths: {} }));
  const api = (title) => ({
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    paths: { '/x': { get: { operationId: 'duplicateOperation', responses: { 200: { description: 'ok' } } } } },
  });
  writeFileSync(join(restDir, 'a-api.json'), JSON.stringify(api('a')));
  writeFileSync(join(restDir, 'b-api.json'), JSON.stringify(api('b')));
  assert.ok(loadOperationIndex(restDir).errors.some((e) => e.includes('operationId duplicateOperation 重复')));

  const routesPath = join(root, 'routes.json');
  writeFileSync(
    routesPath,
    JSON.stringify({
      routes: [
        { routeId: '/x', pageState: 'dashboard', status: 'planned', taskId: 'FE-01' },
        { routeId: '/x', pageState: 'settings', status: 'planned', taskId: 'FE-02' },
      ],
    }),
  );
  assert.ok(loadRouteIndex(routesPath).errors.some((e) => e.includes('routeId /x 重复')));
});

test('CLI：真实矩阵退出码 0，违规矩阵退出码 1', () => {
  const lines = [];
  assert.equal(
    run(['--matrix', MATRIX_PATH], (s) => lines.push(s)),
    0,
  );
  assert.ok(lines.some((l) => l.includes('9/9') && l.includes('12/12')));
  assert.ok(lines.some((l) => l.includes('API 引用 41') && l.includes('路由 13')));

  const root = mkdtempSync(join(tmpdir(), 'fdp-prototype-cli-'));
  const invalidMatrix = realMatrix();
  invalidMatrix.pages[0].elements.pop();
  const invalidMatrixPath = join(root, 'matrix.json');
  writeFileSync(invalidMatrixPath, JSON.stringify(invalidMatrix));
  assert.equal(
    run(
      [
        '--matrix',
        invalidMatrixPath,
        '--rest-dir',
        REST_DIR,
        '--routes',
        ROUTE_REGISTRY_PATH,
        '--source-inventory',
        SOURCE_INVENTORY_PATH,
        '--prototype',
        PROTOTYPE_PATH,
      ],
      () => {},
    ),
    1,
  );
});
