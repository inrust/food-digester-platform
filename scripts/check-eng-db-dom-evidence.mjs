#!/usr/bin/env node
/**
 * ENG/DB/DOM 与 IAC/AUTH/SEC 证据及开发文档维护门禁。
 *
 * 规则：
 *  1. 十三份任务开发文档中的仓库内 Markdown 链接必须可解析；
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
  'docs/dev/IAC-01-应用依赖CDK.md',
  'docs/dev/AUTH-01-Cognito认证与角色授权.md',
  'docs/dev/AUTH-02-Onboarding-Token认证.md',
  'docs/dev/AUTH-03-Device-mTLS身份映射.md',
  'docs/dev/AUTH-04-IoT单设备Policy生成器.md',
  'docs/dev/SEC-01-敏感材料保护组件.md',
];

export const SECURITY_TASK_DOCUMENTS = TASK_DOCUMENTS.slice(-6);

const EXPECTED_TOOLCHAIN = {
  node: '>=24.12 <25',
  nvmrc: '24.12.0',
  packageManager: 'pnpm@10.20.0',
};

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const VOLATILE_TOTAL = /(?:Vitest|contracts|scripts|合计)\s*(?:[+:=]\s*)?\d+(?:\/\d+)?/iu;
const VOLATILE_FILE_COUNT = /(?:实现|测试)[^。\n]*（\d+\s*项/iu;

export function securityDocumentErrors(content, relativeDocument, decisionRegister) {
  const errors = [];
  if (!content.includes('pnpm verify')) {
    errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  }
  const volatileLine = content
    .split(/\r?\n/u)
    .find(
      (line) =>
        /(?:测试|Vitest|全仓)/iu.test(line) && /(?:\d+\s*个(?:测试)?文件|\d+\s*项(?:断言|测试)|\d+\/\d+)/u.test(line),
    );
  if (volatileLine) errors.push(`${relativeDocument}: 不应固化易漂移的测试文件或用例计数`);

  if (relativeDocument.endsWith('AUTH-01-Cognito认证与角色授权.md')) {
    const decision = decisionRegister?.decisions?.find((entry) => entry.id === 'DEC-012');
    if (!decision || decision.status !== 'frozen' || decision.version !== '1.0.0') {
      errors.push(`${relativeDocument}: DEC-012 登记必须为 frozen@1.0.0`);
    }
    if (!/DEC-012 已冻结为 `1\.0\.0`/u.test(content) || /DEC-012[^。\n]*`pending`/iu.test(content)) {
      errors.push(`${relativeDocument}: DEC-012 文档状态必须与 frozen@1.0.0 一致`);
    }
  }
  return errors;
}

export function checkEngDbDomEvidence(root, documentPaths = TASK_DOCUMENTS) {
  const errors = [];
  const packagePath = resolve(root, 'package.json');
  const nvmrcPath = resolve(root, '.nvmrc');
  const decisionRegisterPath = resolve(root, 'contracts/decisions/decision-register.json');
  let decisionRegister;
  if (documentPaths.some((path) => SECURITY_TASK_DOCUMENTS.includes(path))) {
    if (!existsSync(decisionRegisterPath)) {
      errors.push('缺少 contracts/decisions/decision-register.json，无法核对决策状态');
    } else {
      decisionRegister = JSON.parse(readFileSync(decisionRegisterPath, 'utf8'));
    }
  }

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
    if (SECURITY_TASK_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...securityDocumentErrors(content, relativeDocument, decisionRegister));
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
  if (errors.length === 0) console.log('ENG/DB/DOM/IAC/AUTH/SEC 证据与开发文档检查通过');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
