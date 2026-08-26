/**
 * CT-03 零依赖 JSON Schema 校验器（子集实现）。
 *
 * 支持关键字：$ref（同文件 #/... 与同目录 <file>.schema.json#/...）、allOf、
 * type（含联合类型如 ["string","null"]）、properties、required、
 * additionalProperties(false)、enum、pattern、minimum、maximum、minLength、maxLength。
 * format: date-time 由 pattern 强制（UTC、Z 结尾）。
 *
 * 错误返回稳定的点分路径（如 data.severity），供 ingestion 管线记录错误路径。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class SchemaRegistry {
  /** @param {string} schemaDir schemas 目录绝对路径 */
  constructor(schemaDir) {
    this.schemaDir = schemaDir;
    this.cache = new Map();
  }

  load(fileName) {
    if (!this.cache.has(fileName)) {
      const doc = JSON.parse(readFileSync(join(this.schemaDir, fileName), 'utf8'));
      this.cache.set(fileName, { doc, fileName });
    }
    return this.cache.get(fileName);
  }

  /** 解析 $ref 到目标 schema 节点及其所属文档。 */
  resolve(ref, currentFile) {
    let fileName = currentFile;
    let pointer = ref;
    const hashIdx = ref.indexOf('#');
    if (hashIdx > 0) {
      fileName = ref.slice(0, hashIdx);
      pointer = ref.slice(hashIdx);
    }
    if (!pointer.startsWith('#/')) {
      throw new Error(`不支持的 $ref: ${ref}`);
    }
    const { doc } = this.load(fileName);
    let node = doc;
    for (const seg of pointer.slice(2).split('/')) {
      node = node?.[seg];
      if (node === undefined) throw new Error(`$ref 目标不存在: ${ref}`);
    }
    return { node, fileName };
  }
}

export const registryFromUrl = (schemaFileUrl) => new SchemaRegistry(dirname(schemaFileUrl.pathname ?? schemaFileUrl));

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'object') return typeOf(value) === 'object';
  return typeOf(value) === expected;
}

function push(errors, path, keyword, message) {
  errors.push({ path: path === '' ? '(root)' : path, keyword, message });
}

/**
 * 校验 payload，返回错误数组（空数组 = 通过）。
 * @param {object} schema 入口 schema 文档
 * @param {string} schemaFileName 入口文件名（用于相对 $ref 解析）
 * @param {SchemaRegistry} registry
 */
export function validate(schema, schemaFileName, payload, registry) {
  const errors = [];
  visit(schema, schemaFileName, payload, '', errors, registry);
  return errors;
}

function visit(schema, fileName, value, path, errors, registry) {
  if (!schema || typeof schema !== 'object') return;

  if (typeof schema.$ref === 'string') {
    const { node, fileName: targetFile } = registry.resolve(schema.$ref, fileName);
    visit(node, targetFile, value, path, errors, registry);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) visit(sub, fileName, value, path, errors, registry);
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => matchesType(value, t))) {
      push(errors, path, 'type', `期望类型 ${expected.join('|')}，实际 ${typeOf(value)}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    push(errors, path, 'enum', `非法枚举值 ${JSON.stringify(value)}，允许值: ${schema.enum.join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      push(errors, path, 'pattern', `不匹配 ${schema.pattern}: ${JSON.stringify(value)}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(errors, path, 'minLength', `长度 ${value.length} < ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(errors, path, 'maxLength', `长度 ${value.length} > ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push(errors, path, 'minimum', `${value} < ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push(errors, path, 'maximum', `${value} > ${schema.maximum}`);
    }
  }

  if (typeOf(value) === 'object') {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) push(errors, path, 'required', `缺少必填字段 ${key}`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          visit(subSchema, fileName, value[key], path === '' ? key : `${path}.${key}`, errors, registry);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) {
            push(errors, path, 'additionalProperties', `不允许的额外字段 ${key}`);
          }
        }
      }
    }
  }
}

/**
 * 归一化信封：V1 缺省 schemaVer 按 1.0 补齐（返回新对象，不修改入参）。
 * 云端补充字段（receivedAt/deviceId/customerId/topicType 等）由 ingestion 在
 * 校验通过后附加到信封外层，不得混入原始 Payload。
 */
export function normalizeEnvelope(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy && typeof copy === 'object' && copy.meta && typeof copy.meta === 'object') {
    if (copy.meta.schemaVer === undefined) copy.meta.schemaVer = '1.0';
  }
  return copy;
}
