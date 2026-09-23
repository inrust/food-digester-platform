import { readFileSync } from 'node:fs';

export function checkAdminBootstrapSource(expected, actual) {
  if (!/^[a-f0-9]{40}$/u.test(expected ?? '') || actual !== expected) {
    throw new Error('Admin bootstrap source commit does not match approval');
  }
}

if (process.argv[1]?.endsWith('/check-admin-bootstrap-source.mjs')) {
  checkAdminBootstrapSource(
    process.env.FDP_EXPECTED_SOURCE_COMMIT,
    readFileSync('admin-bootstrap-source-commit.txt', 'utf8').trim(),
  );
}
