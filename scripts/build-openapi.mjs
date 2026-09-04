#!/usr/bin/env node
/**
 * 将 OpenAPI 3.1 基座与全部 *-api.json 片段合并为确定性单文件发布产物。
 *
 * 用法：
 *   node scripts/build-openapi.mjs
 *   node scripts/build-openapi.mjs --check
 *   node scripts/build-openapi.mjs [--rest-dir <dir>] [--output <file>] [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const PARAMETER_LOCATIONS = new Set(['query', 'header', 'path', 'cookie']);
const SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(file) {
  const content = readFileSync(file, 'utf8');
  return { content, doc: JSON.parse(content) };
}

function componentPrefix(file) {
  return basename(file, '.json')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function visitSchemas(node, where, errors) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) visitSchemas(item, `${where}[${index}]`, errors);
    return;
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.length === 0 || types.some((type) => !SCHEMA_TYPES.has(type))) {
      errors.push(`${where}: Schema type 非法`);
    }
  }
  if (
    node.required !== undefined &&
    (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string'))
  ) {
    errors.push(`${where}: Schema required 必须为字符串数组`);
  }
  if (
    node.properties !== undefined &&
    (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties))
  ) {
    errors.push(`${where}: Schema properties 必须为对象`);
  }
  for (const [key, value] of Object.entries(node)) visitSchemas(value, `${where}.${key}`, errors);
}

function visitEmbeddedSchemas(node, where, errors) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) visitEmbeddedSchemas(item, `${where}[${index}]`, errors);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'schema') visitSchemas(value, `${where}.schema`, errors);
    else visitEmbeddedSchemas(value, `${where}.${key}`, errors);
  }
}

/** 标准验证器之前的确定性集合级预检；返回可稳定断言的错误。 */
export function validateOpenApiDocuments(documents) {
  const errors = [];
  const operationIds = new Map();
  for (const { file, doc } of documents) {
    if (!/^3\.1\.\d+$/.test(doc.openapi ?? '')) errors.push(`${file}: openapi 必须为 3.1.x`);
    if (!doc.info || typeof doc.info.title !== 'string' || typeof doc.info.version !== 'string') {
      errors.push(`${file}: info.title/info.version 必须存在`);
    }
    if (!doc.paths || typeof doc.paths !== 'object' || Array.isArray(doc.paths)) {
      errors.push(`${file}: paths 必须为对象`);
      continue;
    }
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      if (!path.startsWith('/')) errors.push(`${file}: path 必须以 / 开头: ${path}`);
      if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
        errors.push(`${file} ${path}: Path Item 必须为对象`);
        continue;
      }
      const parameterSets = [pathItem.parameters ?? []];
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const where = `${file} ${method.toUpperCase()} ${path}`;
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
          errors.push(`${where}: Operation 必须为对象`);
          continue;
        }
        if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
          errors.push(`${where}: operationId 必须存在`);
        } else if (operationIds.has(operation.operationId)) {
          errors.push(
            `${where}: operationId ${operation.operationId} 重复（首次出现于 ${operationIds.get(operation.operationId)}）`,
          );
        } else {
          operationIds.set(operation.operationId, where);
        }
        if (
          !operation.responses ||
          typeof operation.responses !== 'object' ||
          Object.keys(operation.responses).length === 0
        ) {
          errors.push(`${where}: responses 必须为非空对象`);
        }
        parameterSets.push(operation.parameters ?? []);
      }
      for (const parameters of parameterSets) {
        if (!Array.isArray(parameters)) {
          errors.push(`${file} ${path}: parameters 必须为数组`);
          continue;
        }
        for (const [index, parameter] of parameters.entries()) {
          if (parameter?.$ref) continue;
          const where = `${file} ${path} parameters[${index}]`;
          if (!parameter || typeof parameter.name !== 'string' || !PARAMETER_LOCATIONS.has(parameter.in)) {
            errors.push(`${where}: parameter 必须包含合法 name/in`);
          }
          if (parameter?.in === 'path' && parameter.required !== true)
            errors.push(`${where}: path parameter 必须 required=true`);
          if (parameter && parameter.schema === undefined && parameter.content === undefined) {
            errors.push(`${where}: parameter 必须包含 schema 或 content`);
          }
        }
      }
    }
    visitSchemas(doc.components?.schemas, `${file}.components.schemas`, errors);
    visitEmbeddedSchemas(doc.paths, `${file}.paths`, errors);
  }
  return { errors, operationIds };
}

function rewriteRefs(node, localRefMap) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, localRefMap));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      if (value.startsWith('openapi-base.json#/')) out[key] = value.slice('openapi-base.json'.length);
      else out[key] = localRefMap.get(value) ?? value;
    } else {
      out[key] = rewriteRefs(value, localRefMap);
    }
  }
  return out;
}

export function bundleOpenApi(restDir) {
  const baseFile = resolve(restDir, 'openapi-base.json');
  const fragmentFiles = readdirSync(restDir)
    .filter((name) => name.endsWith('-api.json'))
    .sort()
    .map((name) => resolve(restDir, name));
  const base = { file: baseFile, ...parseJson(baseFile) };
  const fragments = fragmentFiles.map((file) => ({ file, ...parseJson(file) }));
  const preflight = validateOpenApiDocuments([base, ...fragments]);
  if (preflight.errors.length > 0) throw new Error(preflight.errors.join('\n'));

  const bundle = {
    ...structuredClone(base.doc),
    info: {
      ...structuredClone(base.doc.info),
      title: `${base.doc.info.title} — Unified Bundle`,
      'x-bundle-sources': fragments.map(({ file, content, doc }) => ({
        file: basename(file),
        sha256: digest(content),
        status: doc.info?.['x-contract-status'] === 'planned' ? 'planned' : 'implemented',
      })),
    },
    paths: {},
    components: structuredClone(base.doc.components ?? {}),
  };

  const pathOwners = new Map();
  for (const { file, doc } of fragments) {
    const prefix = componentPrefix(file);
    const localRefMap = new Map();
    for (const [section, entries] of Object.entries(doc.components ?? {})) {
      for (const [name, component] of Object.entries(entries ?? {})) {
        const localRef = `#/components/${section}/${name}`;
        const baseAlias = component?.$ref?.match(/^openapi-base\.json(#\/components\/[^/]+\/[^/]+)$/);
        localRefMap.set(localRef, baseAlias ? baseAlias[1] : `#/components/${section}/${prefix}__${name}`);
      }
    }

    for (const [section, entries] of Object.entries(doc.components ?? {})) {
      bundle.components[section] ??= {};
      for (const [name, component] of Object.entries(entries ?? {})) {
        const targetRef = localRefMap.get(`#/components/${section}/${name}`);
        if (!targetRef.startsWith(`#/components/${section}/${prefix}__`)) continue;
        const targetName = targetRef.split('/').at(-1);
        bundle.components[section][targetName] = rewriteRefs(component, localRefMap);
      }
    }

    for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
      bundle.paths[path] ??= {};
      const rewritten = rewriteRefs(pathItem, localRefMap);
      if (rewritten.parameters !== undefined) {
        if (bundle.paths[path].parameters !== undefined) throw new Error(`${path}: 多个片段重复声明 path parameters`);
        bundle.paths[path].parameters = rewritten.parameters;
      }
      for (const [method, operation] of Object.entries(rewritten)) {
        if (!HTTP_METHODS.has(method)) continue;
        const ownerKey = `${method.toUpperCase()} ${path}`;
        if (pathOwners.has(ownerKey))
          throw new Error(`${ownerKey}: 路径/方法重复（${pathOwners.get(ownerKey)} 与 ${basename(file)}）`);
        pathOwners.set(ownerKey, basename(file));
        bundle.paths[path][method] = {
          ...operation,
          'x-source-document': basename(file),
          'x-contract-status': doc.info?.['x-contract-status'] === 'planned' ? 'planned' : 'implemented',
        };
      }
    }
  }

  const bundledValidation = validateOpenApiDocuments([{ file: 'openapi.bundle.json', doc: bundle }]);
  if (bundledValidation.errors.length > 0) throw new Error(bundledValidation.errors.join('\n'));
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = { restDir: 'contracts/rest', output: 'contracts/rest/openapi.bundle.json', check: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--rest-dir') options.restDir = args.shift();
    else if (arg === '--output') options.output = args.shift();
    else if (arg === '--check') options.check = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export function run(argv, log = console.log) {
  const options = parseArgs(argv);
  const content = bundleOpenApi(options.restDir);
  if (options.check) {
    if (!existsSync(options.output) || readFileSync(options.output, 'utf8') !== content) {
      log(`OpenAPI bundle 已过期：请运行 pnpm openapi:bundle 更新 ${options.output}`);
      return 1;
    }
    log(`OpenAPI bundle 新鲜：${options.output}`);
    return 0;
  }
  writeFileSync(options.output, content);
  log(`OpenAPI bundle 已生成：${options.output}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
