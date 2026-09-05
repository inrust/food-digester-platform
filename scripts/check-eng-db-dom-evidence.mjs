#!/usr/bin/env node
/**
 * ENG/DB/DOM P2 证据与开发文档维护门禁。
 *
 * 规则：
 *  1. 七份任务开发文档中的仓库内 Markdown 链接必须可解析；
 *  2. 开发文档不固化易漂移的测试总数，精确快照统一记录在 docs/audit；
 *  3. Node 与 pnpm 声明必须保持已复验的兼容配对。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TASK_DOCUMENTS = [
  'docs/dev/ENG-01-Monorepo骨架与模块边界.md',
  'docs/dev/ENG-02-开发质量门禁.md',
  'docs/dev/DB-01-ERD.md',
  'docs/dev/DB-02-数据库基础库.md',
  'docs/dev/DOM-01-设备状态机.md',
  'docs/dev/DOM-02-License状态机.md',
  'docs/dev/DOM-03-审计写入库.md',
];

const EXPECTED_TOOLCHAIN = {
  node: '>=20.19 <21',
  nvmrc: '20.19.5',
  packageManager: 'pnpm@10.20.0',
};

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const VOLATILE_TOTAL = /(?:Vitest|contracts|scripts|合计)\s*(?:[+:=]\s*)?\d+(?:\/\d+)?/iu;
const VOLATILE_FILE_COUNT = /(?:实现|测试)[^。\n]*（\d+\s*项/iu;

export function checkEngDbDomEvidence(root, documentPaths = TASK_DOCUMENTS) {
  const errors = [];
  const packagePath = resolve(root, 'package.json');
  const nvmrcPath = resolve(root, '.nvmrc');

  if (!existsSync(packagePath) || !existsSync(nvmrcPath)) {
    errors.push('缺少 package.json 或 .nvmrc，无法核对工具链证据');
  } else {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const nvmrc = readFileSync(nvmrcPath, 'utf8').trim();
    if (manifest.engines?.node !== EXPECTED_TOOLCHAIN.node) {
      errors.push(`engines.node 必须为 ${EXPECTED_TOOLCHAIN.node}`);
    }
    if (manifest.packageManager !== EXPECTED_TOOLCHAIN.packageManager) {
      errors.push(`packageManager 必须为 ${EXPECTED_TOOLCHAIN.packageManager}`);
    }
    if (nvmrc !== EXPECTED_TOOLCHAIN.nvmrc) {
      errors.push(`.nvmrc 必须为 ${EXPECTED_TOOLCHAIN.nvmrc}`);
    }
  }

  for (const relativeDocument of documentPaths) {
    const documentPath = resolve(root, relativeDocument);
    if (!existsSync(documentPath)) {
      errors.push(`${relativeDocument}: 文档不存在`);
      continue;
    }
    const content = readFileSync(documentPath, 'utf8');
    if (VOLATILE_TOTAL.test(content) || VOLATILE_FILE_COUNT.test(content)) {
      errors.push(`${relativeDocument}: 不应固化易漂移的测试数量，请引用 pnpm verify 和审计快照`);
    }

    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = match[1].trim();
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const pathOnly = decodeURIComponent(target.split('#', 1)[0]);
      if (!existsSync(resolve(dirname(documentPath), pathOnly))) {
        errors.push(`${relativeDocument}: 链接目标不存在: ${target}`);
      }
    }
  }

  return errors;
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const errors = checkEngDbDomEvidence(root);
  for (const error of errors) console.error(error);
  if (errors.length === 0) console.log('ENG/DB/DOM 证据与开发文档检查通过');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
