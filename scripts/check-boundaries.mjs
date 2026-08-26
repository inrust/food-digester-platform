#!/usr/bin/env node
/**
 * ENG-01 模块边界与循环依赖检查。
 *
 * 模块边界规则：
 *  1. 共享包（packages/*、contracts、infra）禁止依赖 apps/*（不得反向依赖应用）。
 *  2. 工作区依赖图禁止出现循环依赖。
 *  3. apps/* 之间禁止互相依赖（应用只能通过共享包复用能力）。
 *
 * 用法：
 *   node scripts/check-boundaries.mjs [rootDir] [--json]
 *
 * 退出码：
 *   0  检查通过
 *   1  存在边界违规或循环依赖
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function isApp(relDir) {
  return relDir.startsWith('apps/');
}

function isShared(relDir) {
  return relDir.startsWith('packages/') || relDir === 'contracts' || relDir === 'infra';
}

/** 扫描工作区包：apps/*、packages/*、contracts、infra。 */
export function loadWorkspacePackages(root) {
  const dirs = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${group}/${entry.name}`);
    }
  }
  for (const single of ['contracts', 'infra']) {
    if (existsSync(join(root, single))) dirs.push(single);
  }

  const packages = [];
  for (const relDir of dirs) {
    const manifestPath = join(root, relDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const deps = new Set();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) deps.add(name);
    }
    packages.push({ name: manifest.name, dir: relDir, deps: [...deps] });
  }
  return packages;
}

/**
 * 检查边界违规与循环依赖。
 * 返回 { violations: string[], cycles: string[][] }，均为空表示通过。
 */
export function checkBoundaries(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const violations = [];

  for (const pkg of packages) {
    for (const depName of pkg.deps) {
      const dep = byName.get(depName);
      if (!dep) continue; // 非工作区依赖不检查
      if (isShared(pkg.dir) && isApp(dep.dir)) {
        violations.push(`共享包 ${pkg.name}（${pkg.dir}）禁止反向依赖应用 ${dep.name}（${dep.dir}）`);
      }
      if (isApp(pkg.dir) && isApp(dep.dir)) {
        violations.push(`应用 ${pkg.name}（${pkg.dir}）禁止依赖另一个应用 ${dep.name}（${dep.dir}）`);
      }
    }
  }

  // 循环依赖检测（三色 DFS，仅工作区内部边）
  const cycles = [];
  const state = new Map(); // name -> 1 visiting | 2 done
  const stack = [];

  function visit(name) {
    state.set(name, 1);
    stack.push(name);
    for (const depName of byName.get(name).deps) {
      if (!byName.has(depName)) continue;
      if (state.get(depName) === 1) {
        cycles.push([...stack.slice(stack.indexOf(depName)), depName]);
      } else if (!state.has(depName)) {
        visit(depName);
      }
    }
    stack.pop();
    state.set(name, 2);
  }

  for (const pkg of packages) {
    if (!state.has(pkg.name)) visit(pkg.name);
  }

  return { violations, cycles };
}

function main(argv) {
  const args = argv.slice(2).filter((a) => a !== '--json');
  const jsonMode = argv.includes('--json');
  const root = args[0] ?? process.cwd();

  const packages = loadWorkspacePackages(root);
  const { violations, cycles } = checkBoundaries(packages);

  if (jsonMode) {
    console.log(JSON.stringify({ packages: packages.length, violations, cycles }, null, 2));
  } else {
    console.log(`检查 ${packages.length} 个工作区包`);
    for (const v of violations) console.error(`边界违规：${v}`);
    for (const c of cycles) console.error(`循环依赖：${c.join(' -> ')}`);
    if (violations.length === 0 && cycles.length === 0) {
      console.log('模块边界与循环依赖检查通过');
    }
  }

  process.exitCode = violations.length === 0 && cycles.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv);
}
