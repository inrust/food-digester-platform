#!/usr/bin/env node
/** SEC-01：禁止生产源码绕过统一脱敏器直接写日志或 Trace sink。 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_GROUPS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['dist', 'node_modules', 'test', 'tests', '__tests__']);
const FORBIDDEN = [
  { id: 'direct-console', pattern: /\bconsole\.(?:debug|info|warn|error|log)\s*\(/g },
  { id: 'raw-trace-attribute', pattern: /\.(?:setAttribute|setAttributes|addEvent|recordException)\s*\(/g },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) files.push(path);
  }
  return files;
}

export function scanSensitiveSinks(root) {
  const findings = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const workspace of readdirSync(groupDir)) {
      for (const file of walk(join(groupDir, workspace, 'src'))) {
        const content = readFileSync(file, 'utf8');
        for (const rule of FORBIDDEN) {
          rule.pattern.lastIndex = 0;
          for (const match of content.matchAll(rule.pattern)) {
            const line = content.slice(0, match.index).split('\n').length;
            findings.push({ file: relative(root, file), line, id: rule.id });
          }
        }
      }
    }
  }
  return findings;
}

function main() {
  const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
  const findings = scanSensitiveSinks(root);
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} ${finding.id}\n`);
  }
  if (findings.length > 0) process.exitCode = 1;
  else process.stdout.write('生产日志与 Trace sink 脱敏门禁通过\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
