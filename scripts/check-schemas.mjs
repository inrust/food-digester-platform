#!/usr/bin/env node
/**
 * ENG-02 OpenAPI / JSON Schema 校验门禁。
 *
 * 检查内容：
 *  1. contracts/** 下所有 *.schema.json：JSON 可解析；内部及同目录相对 $ref 均可解析。
 *  2. contracts/rest/openapi-base.json、全部 *-api.json 与统一 bundle：JSON 可解析；
 *     含 openapi/info/paths；所有内部及同目录相对 $ref 均可解析。
 *  3. OpenAPI 3.1 标准语义由 pnpm openapi:check 中的 Redocly spec ruleset 执行。
 *
 * 用法：node scripts/check-schemas.mjs [rootDir]
 * 退出码：0 通过；1 存在失效 Schema 或悬空引用。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const metaValidator = new Ajv2020({ allErrors: true, strict: false });

/** 递归收集对象中的全部 $ref 字符串。 */
export function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

/** 解析 JSON Pointer（#/a/b）到文档节点，失败返回 undefined。 */
function resolvePointer(doc, pointer) {
  let node = doc;
  for (const seg of pointer.slice(2).split('/')) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) return undefined;
  }
  return node;
}

/** 校验单个 JSON Schema 文件，返回错误列表。 */
export function checkSchemaFile(filePath, validateMetaSchema = true) {
  const errors = [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    return [`${filePath}: JSON 解析失败：${err.message}`];
  }
  if (validateMetaSchema && !metaValidator.validateSchema(doc)) {
    errors.push(`${filePath}: JSON Schema 元 Schema 校验失败：${metaValidator.errorsText()}`);
  }
  const dir = dirname(filePath);
  for (const ref of collectRefs(doc)) {
    const hashIdx = ref.indexOf('#');
    const targetFile = hashIdx > 0 ? ref.slice(0, hashIdx) : null;
    const pointer = hashIdx >= 0 ? ref.slice(hashIdx) : ref;
    if (!pointer.startsWith('#/')) {
      errors.push(`${filePath}: 不支持的 $ref（仅允许内部或同目录相对引用）: ${ref}`);
      continue;
    }
    let targetDoc = doc;
    if (targetFile) {
      const targetPath = join(dir, targetFile);
      if (!existsSync(targetPath)) {
        errors.push(`${filePath}: $ref 目标文件不存在: ${ref}`);
        continue;
      }
      try {
        targetDoc = JSON.parse(readFileSync(targetPath, 'utf8'));
      } catch (err) {
        errors.push(`${filePath}: $ref 目标文件解析失败 ${ref}: ${err.message}`);
        continue;
      }
    }
    if (resolvePointer(targetDoc, pointer) === undefined) {
      errors.push(`${filePath}: $ref 目标不存在: ${ref}`);
    }
  }
  return errors;
}

/** 校验 OpenAPI 基座文件，返回错误列表。 */
export function checkOpenApiFile(filePath) {
  const errors = checkSchemaFile(filePath, false); // OpenAPI 语义由 Redocly 校验，此处复用 $ref 解析检查
  let doc;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return errors; // 解析错误已记录
  }
  for (const key of ['openapi', 'info', 'paths']) {
    if (doc[key] === undefined) errors.push(`${filePath}: 缺少 OpenAPI 必填顶层字段 ${key}`);
  }
  return errors;
}

/** 扫描 root/contracts，返回错误列表。 */
export function checkSchemas(root) {
  const contractsDir = join(root, 'contracts');
  const errors = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.schema.json')) errors.push(...checkSchemaFile(p));
    }
  };
  walk(contractsDir);

  const restDir = join(contractsDir, 'rest');
  if (existsSync(restDir)) {
    for (const name of readdirSync(restDir).sort()) {
      if (name === 'openapi-base.json' || name === 'openapi.bundle.json' || name.endsWith('-api.json')) {
        errors.push(...checkOpenApiFile(join(restDir, name)));
      }
    }
  }
  return errors.map((e) => e.replace(`${root}/`, ''));
}

function main(argv) {
  const root = argv[2] ?? process.cwd();
  const errors = checkSchemas(root);
  if (errors.length === 0) {
    console.log('OpenAPI / JSON Schema 校验通过');
  } else {
    for (const e of errors) console.error(`Schema 校验失败：${e}`);
  }
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv);
}
