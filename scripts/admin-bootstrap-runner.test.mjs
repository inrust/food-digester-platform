import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { checkAdminBootstrapSource } from './check-admin-bootstrap-source.mjs';
import {
  AdminBootstrapFailure,
  bootstrapConfig,
  bootstrapConfirmation,
  executeAdminBootstrap,
} from './run-admin-bootstrap.mjs';

const EMAIL = 'first.admin@example.com';
const config = {
  email: EMAIL,
  displayName: 'First Admin',
  emailSha256: bootstrapConfirmation(EMAIL).split(':')[1],
};

function fakeDeps(options = {}) {
  const calls = [];
  let id = 0;
  return {
    calls,
    deps: {
      randomId: () => `id-${++id}`,
      preflight: async () => ({ databaseUserCount: 0, cognitoUserCount: 0, superAdminRoleExists: true }),
      startIntent: async (input) => calls.push(['intent', input]),
      createIdentity: async (input) => {
        calls.push(['create', input]);
        return { username: input.email, cognitoSub: 'sub-1' };
      },
      addToSuperAdminGroup: async (input) => calls.push(['group', input]),
      deleteIdentity: async (input) => {
        calls.push(['delete', input]);
        if (options.deleteFails) throw new Error('delete failed');
      },
      commitDatabase: async (input) => {
        calls.push(['commit', input]);
        if (options.commitFails) throw new Error('23505');
      },
      markFailure: async (input) => calls.push(['failure', input]),
    },
  };
}

test('bootstrap input is bound to the normalized email and never accepts a password', () => {
  const env = {
    FDP_BOOTSTRAP_EMAIL: ' First.Admin@Example.com ',
    FDP_BOOTSTRAP_DISPLAY_NAME: 'First Admin',
    FDP_BOOTSTRAP_CONFIRMATION: bootstrapConfirmation(EMAIL),
  };
  assert.deepEqual(bootstrapConfig(env), config);
  assert.throws(() => bootstrapConfig({ ...env, FDP_BOOTSTRAP_CONFIRMATION: 'CREATE_FIRST_PLATFORM_SUPER_ADMIN' }));
  assert.throws(() => bootstrapConfig({ ...env, FDP_BOOTSTRAP_EMAIL: 'invalid' }));
  assert.equal('FDP_BOOTSTRAP_PASSWORD' in env, false);
});

test('successful bootstrap creates Cognito identity before committing linked database user', async () => {
  const fake = fakeDeps();
  const result = await executeAdminBootstrap(config, fake.deps);
  assert.deepEqual(result, { userId: 'id-1', emailSha256: config.emailSha256, role: 'PlatformSuperAdmin' });
  assert.deepEqual(
    fake.calls.map(([name]) => name),
    ['intent', 'create', 'group', 'commit'],
  );
  assert.equal(fake.calls[3][1].cognitoSub, 'sub-1');
});

test('non-pristine Cognito or database fails before any mutation', async () => {
  const fake = fakeDeps();
  fake.deps.preflight = async () => ({ databaseUserCount: 1, cognitoUserCount: 0, superAdminRoleExists: true });
  await assert.rejects(
    () => executeAdminBootstrap(config, fake.deps),
    (error) => {
      assert.ok(error instanceof AdminBootstrapFailure);
      assert.equal(error.stage, 'pristine-precondition');
      return true;
    },
  );
  assert.deepEqual(fake.calls, []);
});

test('database failure deletes Cognito identity and records compensated failure', async () => {
  const fake = fakeDeps({ commitFails: true });
  await assert.rejects(
    () => executeAdminBootstrap(config, fake.deps),
    (error) => {
      assert.equal(error.stage, 'database-commit');
      return true;
    },
  );
  assert.deepEqual(
    fake.calls.map(([name]) => name),
    ['intent', 'create', 'group', 'commit', 'delete', 'failure'],
  );
  assert.equal(fake.calls.at(-1)[1].reconciliationRequired, false);
});

test('failed Cognito compensation keeps reconciliation required', async () => {
  const fake = fakeDeps({ commitFails: true, deleteFails: true });
  await assert.rejects(
    () => executeAdminBootstrap(config, fake.deps),
    (error) => {
      assert.equal(error.stage, 'cognito-compensation');
      return true;
    },
  );
  assert.equal(fake.calls.at(-1)[1].reconciliationRequired, true);
});

test('source approval requires exact SHA and packager embeds committed SHA', () => {
  const sha = 'a'.repeat(40);
  checkAdminBootstrapSource(sha, sha);
  assert.throws(() => checkAdminBootstrapSource('main', sha));
  assert.throws(() => checkAdminBootstrapSource(sha, 'b'.repeat(40)));

  const dir = mkdtempSync(resolve(tmpdir(), 'fdp-admin-bootstrap-test-'));
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const output = resolve(dir, 'source.zip');
    const packaged = spawnSync(process.execPath, ['scripts/package-admin-bootstrap-source.mjs', head, output], {
      encoding: 'utf8',
    });
    assert.equal(packaged.status, 0);
    const marker = spawnSync('unzip', ['-p', output, 'admin-bootstrap-source-commit.txt'], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.equal(marker, head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner without approved source fails closed without leaking configuration', () => {
  const result = spawnSync(process.execPath, ['scripts/run-admin-bootstrap.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, FDP_EXPECTED_SOURCE_COMMIT: 'NOT_APPROVED' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    kind: 'fdp-admin-bootstrap-failure/v1',
    stage: 'source-approval',
    codes: [],
  });
});
