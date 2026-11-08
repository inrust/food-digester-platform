/** Test-only historical source tree. Never used by the production package CLI. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT, PACKAGE, manifestRows, readCandidateFiles } from '../device-image-target-package.mjs';

export async function candidateFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fdp-image-candidate-')));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const g3 = 'docs/audit/evidence/2026-11-08-device-image-IMG20';
    const names = ['result.json', 'sources.sha256', 'artifacts.sha256'].map((name) => `${g3}/${name}`);
    const manifests = readCandidateFiles(names);
    const paths = [
      ...new Set([
        ...names,
        ...manifestRows(manifests[names[1]]).map((row) => row.path),
        ...manifestRows(manifests[names[2]]).map((row) => row.path),
      ]),
    ];
    const blobs = readCandidateFiles(paths);
    for (const [path, bytes] of Object.entries(blobs)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    // Overlay the current packaging tool and its metadata, while keeping every
    // frozen G3 source/evidence blob intact. No current runtime is certified here.
    const manifest = JSON.parse(readFileSync(join(ROOT, PACKAGE, 'manifest.json')));
    const metadata = [
      ...Object.keys(manifest.inputs),
      ...Object.keys(manifest.files).map((name) => `${PACKAGE}/${name}`),
      `${PACKAGE}/manifest.json`,
    ];
    for (const path of metadata) {
      if (Object.hasOwn(blobs, path)) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(ROOT, path), join(root, path));
    }
    // cat-file only reads the original object database; no worktree/index is changed.
    const git = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8' });
    if (git.status !== 0) throw new Error('CANDIDATE_FIXTURE_GIT_DIRECTORY');
    writeFileSync(join(root, '.git'), `gitdir: ${git.stdout.trim()}\n`);
    const tool = await import(pathToFileURL(join(root, 'scripts/device-image-target-package.mjs')).href);
    return { root, tool, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
