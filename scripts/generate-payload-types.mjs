#!/usr/bin/env node
/**
 * CT-03 类型生成器：从 contracts/mqtt/schemas/*.schema.json 生成 TypeScript 类型。
 *
 * 用法：node scripts/generate-payload-types.mjs [--check]
 *   默认写入 contracts/mqtt/payloads.ts；--check 只校验生成结果与现有文件一致。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCHEMA_DIR = new URL('../contracts/mqtt/schemas/', import.meta.url);
const OUTPUT_PATH = new URL('../contracts/mqtt/payloads.ts', import.meta.url);

const UPLINK = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];

function resolveRef(ref, schemaDir) {
  const [file, pointer] = ref.includes('#') ? ref.split('#') : [ref, ''];
  const doc = JSON.parse(readFileSync(join(schemaDir, file || ''), 'utf8'));
  let node = doc;
  for (const seg of pointer.replace(/^\//, '').split('/')) {
    if (seg) node = node[seg];
  }
  return node;
}

function tsType(prop, schemaDir) {
  if (prop.$ref) {
    // 本项目 data 字段仅引用 utcDateTime
    const target = resolveRef(prop.$ref, schemaDir);
    return tsType(target, schemaDir);
  }
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = prop.type;
  if (Array.isArray(t)) return t.map((x) => (x === 'null' ? 'null' : primitive(x))).join(' | ');
  return primitive(t);
}

function primitive(t) {
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  throw new Error(`不支持的类型: ${t}`);
}

function indent(lines, pad) {
  return lines.map((l) => (l ? pad + l : l)).join('\n');
}

export function renderTypes(schemaDir) {
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.schema.json') && f !== 'common.schema.json')
    .sort();
  if (files.length !== 11) throw new Error(`期望 11 个消息 Schema，实际 ${files.length}`);

  const out = [];
  out.push('/**');
  out.push(' * 由 scripts/generate-payload-types.mjs 从 contracts/mqtt/schemas/*.schema.json 生成。');
  out.push(' * 请勿手工编辑；修改 Schema 后重新运行生成器。');
  out.push(' */');
  out.push('');
  out.push('/** 消息 meta（下行：seq 可选，DEC-006）。 */');
  out.push('export interface Meta {');
  out.push('  id: string;');
  out.push('  ts: string;');
  out.push('  seq?: number;');
  out.push('  schemaVer?: string;');
  out.push('}');
  out.push('');
  out.push('/** 上行消息 meta：seq 必填。 */');
  out.push('export interface MetaSeq extends Meta {');
  out.push('  seq: number;');
  out.push('}');
  out.push('');
  out.push('export interface Audit {');
  out.push('  hash: string;');
  out.push('}');

  const payloadNames = [];
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
    const name = schema['x-typescript-name'];
    if (!name) throw new Error(`${file} 缺少 x-typescript-name`);
    const topicType = file.replace('.schema.json', '');
    const data = schema.properties.data;
    const required = new Set(data.required ?? []);

    out.push('');
    out.push(`export interface ${name}Data {`);
    const lines = [];
    for (const [prop, def] of Object.entries(data.properties)) {
      if (def.description) lines.push(`/** ${def.description} */`);
      lines.push(`${prop}${required.has(prop) ? '' : '?'}: ${tsType(def, schemaDir)};`);
    }
    out.push(indent(lines, '  '));
    out.push('}');

    const metaType = UPLINK.includes(topicType) ? 'MetaSeq' : 'Meta';
    const hasAudit = 'audit' in schema.properties;
    out.push('');
    out.push(`export interface ${name}Payload {`);
    out.push(`  meta: ${metaType};`);
    out.push(`  ${hasAudit ? 'audit: Audit;' : 'audit?: never;'}`);
    out.push('  data: ' + name + 'Data;');
    out.push('}');
    payloadNames.push([topicType, `${name}Payload`]);
  }

  out.push('');
  out.push('/** Topic type 到 Payload 类型的映射。 */');
  out.push('export interface PayloadByTopicType {');
  out.push(indent(payloadNames.map(([t, p]) => `${t}: ${p};`), '  '));
  out.push('}');
  out.push('');
  return out.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const schemaDir = fileURLToPath(SCHEMA_DIR);
  const outputPath = fileURLToPath(OUTPUT_PATH);
  const content = renderTypes(schemaDir);
  if (process.argv.includes('--check')) {
    const existing = readFileSync(outputPath, 'utf8');
    if (existing !== content) {
      console.error('payloads.ts 与 Schema 不一致，请运行 node scripts/generate-payload-types.mjs');
      process.exit(1);
    }
    console.log('payloads.ts 与 Schema 一致');
  } else {
    writeFileSync(outputPath, content);
    console.log(`已生成 ${outputPath}`);
  }
}
