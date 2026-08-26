#!/usr/bin/env node
/**
 * ENG-02 敏感信息扫描门禁。
 *
 * 高精度模式（宁缺毋滥，避免误报阻塞开发）：
 *  1. PEM 私钥块（PRIVATE KEY-----）；
 *  2. AWS Access Key ID（AKIA...）；
 *  3. GitHub 个人令牌（ghp_...）；
 *  4. Slack 令牌（xoxb/xoxp/xoxa/xoxr/xoxs-...）。
 *
 * 扫描范围为 git 跟踪文件（git ls-files），跳过二进制与大文件。
 * 本脚本自身及测试夹具通过内容拼接避免命中规则。
 *
 * 用法：node scripts/check-secrets.mjs [rootDir]
 * 退出码：0 通过；1 检出疑似敏感信息。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_EXTENSIONS = /\.(pdf|png|jpe?g|gif|webp|zip|gz|ico|woff2?)$/i;

export const SECRET_PATTERNS = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-pat', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

/** 扫描单份文本内容，返回命中列表 [{ id, line }]。 */
export function scanContent(content) {
  const findings = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of SECRET_PATTERNS) {
      if (re.test(lines[i])) findings.push({ id, line: i + 1 });
    }
  }
  return findings;
}

/** 列出 git 跟踪文件。 */
export function listTrackedFiles(root) {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** 扫描仓库，返回 [{ file, id, line }]。 */
export function scanRepository(root) {
  const findings = [];
  for (const rel of listTrackedFiles(root)) {
    if (BINARY_EXTENSIONS.test(rel)) continue;
    const abs = join(root, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // 已删除未提交等情况
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue; // 二进制保护
    for (const f of scanContent(content)) findings.push({ file: rel, ...f });
  }
  return findings;
}

function main(argv) {
  const root = argv[2] ?? process.cwd();
  const findings = scanRepository(root);
  if (findings.length === 0) {
    console.log('敏感信息扫描通过');
  } else {
    for (const f of findings) console.error(`检出疑似敏感信息：${f.file}:${f.line} (${f.id})`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv);
}
