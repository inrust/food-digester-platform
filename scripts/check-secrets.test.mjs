/**
 * ENG-02 check-secrets 失败示例测试。
 * 注意：示例密钥通过字符串拼接构造，避免本测试文件自身命中扫描规则。
 * 运行：node --test scripts/check-secrets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanContent, scanRepository, listRepositoryFiles } from './check-secrets.mjs';

const pemExample = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const awsExample = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'.slice(0, 16);
const githubExample = 'ghp_' + 'a'.repeat(36);
const slackExample = 'xox' + 'b-' + '1234567890-abcdef';

test('失败示例：PEM 私钥块被检出', () => {
  const findings = scanContent(`const key = \`\n${pemExample}\nabc\`;`);
  assert.ok(findings.some((f) => f.id === 'pem-private-key' && f.line === 2));
});

test('失败示例：AWS Access Key ID 被检出', () => {
  const findings = scanContent(`aws_access_key_id = ${awsExample}`);
  assert.ok(findings.some((f) => f.id === 'aws-access-key-id'));
});

test('失败示例：GitHub 令牌被检出', () => {
  assert.ok(scanContent(githubExample).some((f) => f.id === 'github-pat'));
});

test('失败示例：Slack 令牌被检出', () => {
  assert.ok(scanContent(slackExample).some((f) => f.id === 'slack-token'));
});

test('正常内容不误报', () => {
  const benign = [
    'const PACKAGE_NAME = "@fdp/observability";',
    '密码 Hash 禁止写入日志（见 DEC-004）',
    'aws_access_key_id 由 IAM Role 注入，不落盘',
  ].join('\n');
  assert.deepEqual(scanContent(benign), []);
});

test('失败示例：未跟踪且未忽略文件中的私钥也被扫描', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-secrets-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, 'untracked-key.txt'), pemExample);
  assert.ok(scanRepository(root).some((f) => f.file === 'untracked-key.txt' && f.id === 'pem-private-key'));
});

test('当前仓库通过敏感信息扫描', () => {
  const root = new URL('..', import.meta.url).pathname;
  assert.deepEqual(scanRepository(root), []);
});

// Populate only the temporary Git index: no thousands of physical fixture files are needed.
test('超过1MiB的路径清单完整扫描，末尾敏感文件不能被截断跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-secrets-large-index-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      input: '',
      encoding: 'utf8',
    }).trim();
    const names = Array.from(
      { length: 6000 },
      (_, i) => `fixture-${String(i).padStart(5, '0')}-${'x'.repeat(180)}.txt`,
    );
    names.push('zzzz-last-sensitive-fixture.txt');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: names.map((name) => `100644 ${blob}\t${name}\n`).join(''),
    });
    writeFileSync(join(root, names.at(-1)), pemExample);
    assert.ok(Buffer.byteLength(names.join('\n')) > 1024 * 1024);
    assert.deepEqual(listRepositoryFiles(root), names);
    assert.ok(scanRepository(root).some((f) => f.file === names.at(-1) && f.id === 'pem-private-key'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
