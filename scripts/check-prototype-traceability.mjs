#!/usr/bin/env node
/**
 * CT-06 原型追踪矩阵自动完整性检查。
 *
 * 用法：node scripts/check-prototype-traceability.mjs [--matrix <path>] [--json]
 * 退出码：0 通过；1 存在违规。
 *
 * 规则：
 *  R1 9 个可见菜单、12 个页面状态全覆盖且唯一；
 *  R2 每个菜单/页面/元素均有唯一处置结论（Adopt/Adapt/Defer/Reject）；
 *  R3 Adapt/Defer/Reject 必须写明上级依据（basis）；
 *  R4 Adopt/Adapt 的生产字段（field/table-column/filter）必须有 API 来源（taskId + operationId）；
 *     clientSide 纯 UI 元素除外；
 *  R5 带 rejectCategory（realtime-stream/plaintext-password/mixed-status）的项必须为 Reject
 *     且不得携带实现任务来源（不进入实现任务）；
 *  R6 taskId / operationId / routeId 格式固定；
 *  R7 角色必须是已知 RBAC 角色（DEC-012 暂定矩阵）。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXPECTED_MENUS = [
  'menu.dashboard',
  'menu.device-view',
  'menu.device-operate',
  'menu.device-group',
  'menu.device-consumable',
  'menu.esg-overview',
  'menu.esg-device',
  'menu.contract-modify',
  'menu.settings',
];
const EXPECTED_PAGES = [
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
const DISPOSITIONS = ['Adopt', 'Adapt', 'Defer', 'Reject'];
const KINDS = ['field', 'table-column', 'filter', 'button', 'modal'];
const ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const REJECT_CATEGORIES = ['realtime-stream', 'plaintext-password', 'mixed-status'];
const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;
const ROUTE_ID = /^\/[a-z0-9\-/]*$/;
const COMMAND_CODE = /^[A-Z][A-Z0-9_]*$/;

export function checkMatrix(matrix) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);

  if (!matrix || typeof matrix !== 'object') return ['矩阵顶层必须为对象'];
  if (!Array.isArray(matrix.menus) || !Array.isArray(matrix.pages)) {
    return ['矩阵必须包含 menus 和 pages 数组'];
  }

  // R1 菜单覆盖
  const menuIds = matrix.menus.map((m) => m.menuId);
  if (new Set(menuIds).size !== menuIds.length) err('menus', 'menuId 存在重复');
  for (const id of EXPECTED_MENUS) {
    if (!menuIds.includes(id)) err('menus', `缺少菜单 ${id}`);
  }
  for (const id of menuIds) {
    if (!EXPECTED_MENUS.includes(id)) err('menus', `未知菜单 ${id}`);
  }

  // R1 页面覆盖
  const pageStates = matrix.pages.map((p) => p.pageState);
  if (new Set(pageStates).size !== pageStates.length) err('pages', 'pageState 存在重复');
  for (const p of EXPECTED_PAGES) {
    if (!pageStates.includes(p)) err('pages', `缺少页面 ${p}`);
  }
  for (const p of pageStates) {
    if (!EXPECTED_PAGES.includes(p)) err('pages', `未知页面 ${p}`);
  }

  // 菜单结构
  for (const m of matrix.menus) {
    const where = `menu[${m.menuId ?? '?'}]`;
    if (!DISPOSITIONS.includes(m.disposition)) err(where, `缺少合法处置结论（${m.disposition}）`);
    if (!ROUTE_ID.test(m.routeId ?? '')) err(where, `routeId 格式非法: ${m.routeId}`);
    if (!TASK_ID.test(m.feTask ?? '')) err(where, `feTask 格式非法: ${m.feTask}`);
    if (!Array.isArray(m.roles) || m.roles.length === 0) err(where, 'roles 必须非空');
    for (const r of m.roles ?? []) {
      if (!ROLES.includes(r)) err(where, `未知角色 ${r}（R7）`);
    }
    if (!EXPECTED_PAGES.includes(m.pageState)) err(where, `菜单指向未知页面 ${m.pageState}`);
  }

  // 页面与元素
  const elementIds = new Set();
  for (const p of matrix.pages) {
    const where = `page[${p.pageState ?? '?'}]`;
    if (!DISPOSITIONS.includes(p.disposition)) err(where, `页面缺少合法处置结论（${p.disposition}）`);
    if ((p.disposition === 'Adapt' || p.disposition === 'Defer' || p.disposition === 'Reject') && !p.basis) {
      err(where, 'Adapt/Defer/Reject 页面必须写明上级依据（R3）');
    }
    if (!ROUTE_ID.test(p.routeId ?? '')) err(where, `routeId 格式非法: ${p.routeId}`);
    if (!Array.isArray(p.feTasks) || p.feTasks.length === 0 || !p.feTasks.every((t) => TASK_ID.test(t))) {
      err(where, 'feTasks 必须为非空合法任务 ID');
    }
    if (!Array.isArray(p.beTasks) || !p.beTasks.every((t) => TASK_ID.test(t))) {
      err(where, 'beTasks 必须为合法任务 ID');
    }
    if (!Array.isArray(p.elements) || p.elements.length === 0) {
      err(where, '页面必须至少有一个元素');
      continue;
    }
    for (const el of p.elements) {
      const ew = `${where}.${el.id ?? '?'}`;
      if (!el.id || elementIds.has(el.id)) err(ew, '元素 ID 缺失或重复（每项必须有唯一处置结论，R2）');
      elementIds.add(el.id);
      if (!el.id?.startsWith(`${p.pageState}.`)) err(ew, '元素 ID 必须以页面状态为前缀');
      if (!KINDS.includes(el.kind)) err(ew, `未知元素类型 ${el.kind}`);
      if (!DISPOSITIONS.includes(el.disposition)) {
        err(ew, `缺少合法处置结论（${el.disposition}）`);
        continue;
      }
      // R3
      if (el.disposition !== 'Adopt' && !el.basis) err(ew, `${el.disposition} 必须写明上级依据 basis（R3）`);
      // R5
      if (el.rejectCategory) {
        if (!REJECT_CATEGORIES.includes(el.rejectCategory)) err(ew, `未知 rejectCategory ${el.rejectCategory}`);
        if (el.disposition !== 'Reject') err(ew, `带 rejectCategory 的项必须为 Reject（R5）`);
        if (el.source?.taskId) err(ew, '被拒绝项不得携带实现任务来源（R5）');
      }
      // R4/R6
      if (el.disposition === 'Adopt' || el.disposition === 'Adapt') {
        if (!el.source || !TASK_ID.test(el.source.taskId ?? '')) {
          err(ew, 'Adopt/Adapt 必须有实现任务来源 source.taskId（R4）');
        }
        const needsApi = ['field', 'table-column', 'filter'].includes(el.kind) && !el.clientSide;
        if (needsApi && !OPERATION_ID.test(el.source?.api ?? '')) {
          err(ew, '生产字段必须有 API 来源（operationId）（R4）');
        }
        if (el.source?.api && !OPERATION_ID.test(el.source.api)) err(ew, `operationId 格式非法: ${el.source.api}`);
        if (el.source?.commandCode && !COMMAND_CODE.test(el.source.commandCode)) {
          err(ew, `commandCode 格式非法: ${el.source.commandCode}`);
        }
        if (el.source?.routeId && !ROUTE_ID.test(el.source.routeId)) err(ew, `routeId 格式非法: ${el.source.routeId}`);
      }
    }
  }

  return errors;
}

function parseArgs(argv) {
  const opts = { matrix: 'contracts/prototype-traceability.yaml', json: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--matrix') opts.matrix = args.shift();
    else if (arg === '--json') opts.json = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

export function run(argv, log = console.log) {
  const opts = parseArgs(argv);
  // 文件采用 YAML 1.2 的 JSON 语法子集，零依赖解析
  const matrix = JSON.parse(readFileSync(opts.matrix, 'utf8'));
  const errors = checkMatrix(matrix);
  const stats = {
    menus: matrix.menus.length,
    pages: matrix.pages.length,
    elements: matrix.pages.reduce((n, p) => n + p.elements.length, 0),
    byDisposition: {},
  };
  for (const p of matrix.pages) {
    for (const el of p.elements) {
      stats.byDisposition[el.disposition] = (stats.byDisposition[el.disposition] ?? 0) + 1;
    }
  }
  const result = { ok: errors.length === 0, errors, stats };
  if (opts.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log(`菜单 ${stats.menus}/9，页面 ${stats.pages}/12，元素 ${stats.elements}（${Object.entries(stats.byDisposition).map(([k, v]) => `${k}:${v}`).join(', ')}）`);
    for (const e of errors) log(`  ✗ ${e}`);
    log(errors.length === 0 ? '检查通过' : '检查失败');
  }
  return errors.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
