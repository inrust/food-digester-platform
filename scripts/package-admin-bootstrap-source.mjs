#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const [sha, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/u.test(sha ?? '') || !output?.endsWith('.zip')) {
  throw new Error('Usage: node scripts/package-admin-bootstrap-source.mjs <40-char SHA> <output.zip>');
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`Packaging failed: ${command}`);
  return result.stdout;
};
const dir = mkdtempSync(resolve(tmpdir(), 'fdp-admin-bootstrap-'));
try {
  if (existsSync(resolve(output))) throw new Error('Output already exists; refuse to append/overwrite');
  const archive = resolve(dir, 'source.tar');
  run('git', ['archive', '--format=tar', '--output', archive, sha]);
  run('tar', ['-xf', archive, '-C', dir]);
  run('unlink', [archive]);
  writeFileSync(resolve(dir, 'admin-bootstrap-source-commit.txt'), `${sha}\n`, { mode: 0o600 });
  run('zip', ['-qr', resolve(output), '.'], { cwd: dir });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ sourceCommit: sha, artifact: resolve(output) }));
