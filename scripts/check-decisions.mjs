#!/usr/bin/env node
/**
 * CT-01 决策登记自动检查。
 *
 * 用法：
 *   node scripts/check-decisions.mjs [--register <path>] [--contract-version <path>] [--fail-on-pending] [--json]
 *   node scripts/check-decisions.mjs trace <契约文件...> [--register <path>]
 *
 * 退出码：
 *   0  结构校验通过（默认模式下未决决策仅报告，不失败）
 *   1  结构/一致性/追溯校验失败
 *   2  仅当 --fail-on-pending 且存在未决（pending/proposed）决策
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;
const ENTRY_ID = /^(DEC|PRI|ADP)-\d{3}$/;
const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;
const UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DECISION_REF = /^(DEC|PRI|ADP)-\d{3}@\d+\.\d+\.\d+$/;
const DECISION_STATUSES = ['pending', 'proposed', 'frozen', 'superseded'];
const PRINCIPLE_STATUSES = ['active', 'superseded'];

export function loadJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors.push(`${path}: 无法读取或解析 JSON：${err.message}`);
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value, minItems, itemPattern, path, errors) {
  if (!Array.isArray(value) || value.length < minItems) {
    errors.push(`${path}: 必须为长度 >= ${minItems} 的数组`);
    return;
  }
  value.forEach((item, i) => {
    if (!isNonEmptyString(item)) {
      errors.push(`${path}[${i}]: 必须为非空字符串`);
    } else if (itemPattern && !itemPattern.test(item)) {
      errors.push(`${path}[${i}]: "${item}" 不匹配 ${itemPattern}`);
    }
  });
}

function validateHistory(history, entryPath, entryVersion, errors) {
  if (!Array.isArray(history) || history.length < 1) {
    errors.push(`${entryPath}.history: 至少需要一条历史记录`);
    return;
  }
  history.forEach((h, i) => {
    const p = `${entryPath}.history[${i}]`;
    if (!h || typeof h !== 'object') {
      errors.push(`${p}: 必须为对象`);
      return;
    }
    if (!SEMVER.test(h.version ?? '')) errors.push(`${p}.version: 必须为 semver`);
    if (!UTC_DATETIME.test(h.at ?? '')) errors.push(`${p}.at: 必须为 UTC ISO-8601（以 Z 结尾）`);
    if (!isNonEmptyString(h.by)) errors.push(`${p}.by: 必填`);
    if (!isNonEmptyString(h.note)) errors.push(`${p}.note: 必填`);
  });
  const last = history[history.length - 1];
  if (last && last.version !== entryVersion) {
    errors.push(`${entryPath}: 条目版本 ${entryVersion} 与最后一条 history 版本 ${last.version} 不一致`);
  }
}

/**
 * 校验决策登记结构与状态不变量。
 * @returns {{errors: string[], pending: Array<{id:string,status:string,title:string,blockingTasks:string[]}>}}
 */
export function validateRegister(register, path = 'decision-register.json') {
  const errors = [];
  const pending = [];
  if (!register || typeof register !== 'object' || Array.isArray(register)) {
    return { errors: [`${path}: 顶层必须为 JSON 对象`], pending };
  }

  if (!SEMVER.test(register.registerVersion ?? '')) {
    errors.push(`${path}.registerVersion: 必须为 semver`);
  }
  if (!UTC_DATETIME.test(register.updatedAt ?? '')) {
    errors.push(`${path}.updatedAt: 必须为 UTC ISO-8601（以 Z 结尾）`);
  }

  if (!Array.isArray(register.sourceDocuments) || register.sourceDocuments.length < 1) {
    errors.push(`${path}.sourceDocuments: 至少需要一条来源文档`);
  } else {
    register.sourceDocuments.forEach((doc, i) => {
      const p = `${path}.sourceDocuments[${i}]`;
      if (!Number.isInteger(doc.tier) || doc.tier < 1 || doc.tier > 3) {
        errors.push(`${p}.tier: 必须为 1~3`);
      }
      for (const key of ['id', 'file', 'title']) {
        if (!isNonEmptyString(doc[key])) errors.push(`${p}.${key}: 必填`);
      }
    });
  }

  const seenIds = new Map();
  const checkUniqueId = (id, entryPath) => {
    if (!ENTRY_ID.test(id ?? '')) {
      errors.push(`${entryPath}.id: "${id}" 不匹配 DEC/PRI/ADP-xxx 格式`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${entryPath}.id: 决策 ID "${id}" 重复（首次出现于 ${seenIds.get(id)}）`);
    } else {
      seenIds.set(id, entryPath);
    }
  };

  if (!Array.isArray(register.principles)) {
    errors.push(`${path}.principles: 必须为数组`);
  } else {
    register.principles.forEach((pr, i) => {
      const p = `${path}.principles[${i}]`;
      if (!/^(PRI|ADP)-\d{3}$/.test(pr.id ?? '')) {
        errors.push(`${p}.id: 原则 ID 必须为 PRI-xxx 或 ADP-xxx`);
      }
      checkUniqueId(pr.id, p);
      if (!SEMVER.test(pr.version ?? '')) errors.push(`${p}.version: 必须为 semver`);
      if (!PRINCIPLE_STATUSES.includes(pr.status)) {
        errors.push(`${p}.status: 必须为 ${PRINCIPLE_STATUSES.join('/')}`);
      }
      for (const key of ['title', 'statement', 'approvedBy']) {
        if (!isNonEmptyString(pr[key])) errors.push(`${p}.${key}: 必填`);
      }
      isStringArray(pr.affectedModules, 1, null, `${p}.affectedModules`, errors);
      validateHistory(pr.history, p, pr.version, errors);
    });
  }

  if (!Array.isArray(register.decisions)) {
    errors.push(`${path}.decisions: 必须为数组`);
  } else {
    register.decisions.forEach((dec, i) => {
      const p = `${path}.decisions[${i}]`;
      if (!/^DEC-\d{3}$/.test(dec.id ?? '')) {
        errors.push(`${p}.id: 决策 ID 必须为 DEC-xxx`);
      }
      checkUniqueId(dec.id, p);
      if (!SEMVER.test(dec.version ?? '')) errors.push(`${p}.version: 必须为 semver`);
      if (!DECISION_STATUSES.includes(dec.status)) {
        errors.push(`${p}.status: 必须为 ${DECISION_STATUSES.join('/')}`);
      }
      for (const key of ['title', 'conflict', 'provisionalValue']) {
        if (!isNonEmptyString(dec[key])) errors.push(`${p}.${key}: 必填`);
      }
      // 状态不变量：未决不得有批准人；冻结必须有批准人、批准时间且版本 >= 1.0.0
      if (dec.status === 'pending' || dec.status === 'proposed') {
        if (dec.approver !== null) errors.push(`${p}.approver: ${dec.status} 状态必须为 null`);
        if (dec.approvedAt !== null) errors.push(`${p}.approvedAt: ${dec.status} 状态必须为 null`);
        pending.push({ id: dec.id, status: dec.status, title: dec.title, blockingTasks: dec.blockingTasks ?? [] });
      }
      if (dec.status === 'frozen') {
        if (!isNonEmptyString(dec.approver)) errors.push(`${p}.approver: frozen 状态必填批准人`);
        if (!UTC_DATETIME.test(dec.approvedAt ?? '')) {
          errors.push(`${p}.approvedAt: frozen 状态必填 UTC 批准时间`);
        }
        const major = Number((dec.version ?? '0').split('.')[0]);
        if (SEMVER.test(dec.version ?? '') && major < 1) {
          errors.push(`${p}.version: frozen 决策版本必须 >= 1.0.0`);
        }
      }
      if (dec.approvedAt !== null && !UTC_DATETIME.test(dec.approvedAt ?? '')) {
        errors.push(`${p}.approvedAt: 必须为 UTC ISO-8601 或 null`);
      }
      isStringArray(dec.blockingTasks, 1, TASK_ID, `${p}.blockingTasks`, errors);
      isStringArray(dec.affectedModules, 1, null, `${p}.affectedModules`, errors);
      isStringArray(dec.sourceRefs, 1, null, `${p}.sourceRefs`, errors);
      validateHistory(dec.history, p, dec.version, errors);
    });
  }

  return { errors, pending };
}

/**
 * 校验契约版本文件与决策登记版本一致。
 */
export function validateContractVersion(contractVersion, register, path = 'contract-version.json') {
  const errors = [];
  if (!contractVersion || typeof contractVersion !== 'object') {
    return [`${path}: 顶层必须为 JSON 对象`];
  }
  if (!SEMVER.test(contractVersion.contractVersion ?? '')) {
    errors.push(`${path}.contractVersion: 必须为 semver`);
  }
  if (contractVersion.decisionRegisterVersion !== register.registerVersion) {
    errors.push(
      `${path}.decisionRegisterVersion (${contractVersion.decisionRegisterVersion}) 与登记 registerVersion (${register.registerVersion}) 不一致`,
    );
  }
  return errors;
}

function collectDecisionRefs(node, filePath, jsonPointer, refs) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectDecisionRefs(item, filePath, `${jsonPointer}/${i}`, refs));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'x-decision-versions') {
        if (!Array.isArray(value) || value.length < 1) {
          refs.push({ ref: null, pointer: `${jsonPointer}/${key}`, error: 'x-decision-versions 必须为非空数组' });
          continue;
        }
        value.forEach((v, i) => {
          const pointer = `${jsonPointer}/${key}/${i}`;
          if (typeof v !== 'string' || !DECISION_REF.test(v)) {
            refs.push({ ref: v, pointer, error: `格式必须为 决策ID@semver，实际为 ${JSON.stringify(v)}` });
          } else {
            refs.push({ ref: v, pointer });
          }
        });
      } else {
        collectDecisionRefs(value, filePath, `${jsonPointer}/${key}`, refs);
      }
    }
  }
}

/**
 * 追溯校验：契约文件中的 x-decision-versions 引用必须存在于登记且版本一致。
 */
export function validateTraceability(files, register) {
  const errors = [];
  const entries = new Map();
  for (const pr of register.principles ?? []) entries.set(pr.id, pr);
  for (const dec of register.decisions ?? []) entries.set(dec.id, dec);

  const checked = [];
  for (const file of files) {
    const loadErrors = [];
    const doc = loadJson(file, loadErrors);
    errors.push(...loadErrors);
    if (!doc) continue;
    const refs = [];
    collectDecisionRefs(doc, file, '#', refs);
    if (refs.length === 0) {
      errors.push(`${file}: 未找到 x-decision-versions 声明，契约文件必须声明决策追溯引用`);
      continue;
    }
    for (const { ref, pointer, error } of refs) {
      if (error) {
        errors.push(`${file} ${pointer}: ${error}`);
        continue;
      }
      const [id, version] = ref.split('@');
      const entry = entries.get(id);
      if (!entry) {
        errors.push(`${file} ${pointer}: 引用的决策 "${id}" 在登记中不存在`);
      } else if (entry.version !== version) {
        errors.push(`${file} ${pointer}: 引用版本 ${version} 与登记版本 ${entry.version} 不一致`);
      } else {
        checked.push({ file, pointer, ref, status: entry.status });
      }
    }
  }
  return { errors, checked };
}

function parseArgs(argv) {
  const opts = {
    mode: 'validate',
    files: [],
    register: 'contracts/decisions/decision-register.json',
    contractVersion: 'contracts/contract-version.json',
    failOnPending: false,
    json: false,
  };
  const args = [...argv];
  if (args[0] === 'trace') {
    opts.mode = 'trace';
    args.shift();
  }
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--register') opts.register = args.shift();
    else if (arg === '--contract-version') opts.contractVersion = args.shift();
    else if (arg === '--fail-on-pending') opts.failOnPending = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
    else opts.files.push(arg);
  }
  return opts;
}

export function run(argv, log = console.log) {
  const opts = parseArgs(argv);
  const errors = [];
  const register = loadJson(opts.register, errors);
  if (!register) {
    log(JSON.stringify({ ok: false, errors }, null, 2));
    return 1;
  }

  if (opts.mode === 'trace') {
    if (opts.files.length === 0) {
      log('trace 模式需要至少一个契约文件参数');
      return 1;
    }
    const { errors: traceErrors, checked } = validateTraceability(opts.files, register);
    const result = { ok: traceErrors.length === 0, mode: 'trace', checkedRefs: checked.length, errors: traceErrors };
    log(opts.json ? JSON.stringify(result, null, 2) : formatHuman(result, checked));
    return traceErrors.length === 0 ? 0 : 1;
  }

  const { errors: regErrors, pending } = validateRegister(register, opts.register);
  errors.push(...regErrors);

  const contractVersion = loadJson(opts.contractVersion, errors);
  if (contractVersion && regErrors.length === 0) {
    errors.push(...validateContractVersion(contractVersion, register, opts.contractVersion));
  }

  const result = {
    ok: errors.length === 0,
    mode: 'validate',
    registerVersion: register.registerVersion,
    pendingCount: pending.length,
    pending,
    errors,
  };
  log(opts.json ? JSON.stringify(result, null, 2) : formatHuman(result));
  if (errors.length > 0) return 1;
  if (opts.failOnPending && pending.length > 0) return 2;
  return 0;
}

function formatHuman(result, checked = []) {
  const lines = [];
  if (result.mode === 'validate') {
    lines.push(`决策登记版本: ${result.registerVersion}`);
    if (result.pending.length > 0) {
      lines.push(`未决决策（${result.pending.length} 条）:`);
      for (const p of result.pending) {
        lines.push(`  [${p.status}] ${p.id} ${p.title}（阻塞: ${p.blockingTasks.join(', ')}）`);
      }
    } else {
      lines.push('未决决策: 0');
    }
  } else {
    lines.push(`追溯引用检查: ${result.checkedRefs} 条通过`);
    for (const c of checked) lines.push(`  ${c.file} ${c.pointer} -> ${c.ref} [${c.status}]`);
  }
  if (result.errors.length > 0) {
    lines.push(`错误（${result.errors.length} 条）:`);
    for (const e of result.errors) lines.push(`  ✗ ${e}`);
  }
  lines.push(result.ok ? '检查通过' : '检查失败');
  return lines.join('\n');
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
