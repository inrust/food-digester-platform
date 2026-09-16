import { readFileSync } from 'node:fs';

export function checkMigrationSource(expected, actual) {
  if (!/^[a-f0-9]{40}$/u.test(expected ?? '') || actual !== expected) {
    throw new Error('Migration source commit does not match approval');
  }
}
if (process.argv[1]?.endsWith('/check-migration-source.mjs')) {
  checkMigrationSource(
    process.env.FDP_EXPECTED_SOURCE_COMMIT,
    readFileSync('migration-source-commit.txt', 'utf8').trim(),
  );
}
