import { assert, test } from 'vitest';
import {
  computePasswordVerifierClaim,
  formatCognitoTimestamp,
  generateSrpEphemeral,
  padHex,
  SrpError,
  SRP_N_HEX,
  userPoolNameOf,
} from '../src/auth/srp.js';
import { FakeCognitoServer } from './fake-cognito.js';
import { expectRejects } from './helpers.js';

const POOL_ID = 'ap-east-1_TestPool';

test('padHex：奇数长度补 0，最高位置位补 00，其余不变', () => {
  assert.equal(padHex('abc'), '0abc');
  assert.equal(padHex('8f'), '008f');
  assert.equal(padHex('FAB'), '0FAB');
  assert.equal(padHex('7f'), '7f');
  assert.equal(padHex('02'), '02');
});

test('formatCognitoTimestamp：UTC 英文格式，日不补零', () => {
  assert.equal(formatCognitoTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), 'Thu Jan 1 00:00:00 UTC 2026');
  assert.equal(formatCognitoTimestamp(new Date(Date.UTC(2026, 11, 25, 23, 59, 58))), 'Fri Dec 25 23:59:58 UTC 2026');
});

test('userPoolNameOf：取下划线后部分；非法 PoolId 失败关闭', () => {
  assert.equal(userPoolNameOf('ap-east-1_abc123'), 'abc123');
  assert.throws(() => userPoolNameOf('nopool'), SrpError);
  assert.throws(() => userPoolNameOf('ap-east-1_'), SrpError);
});

test('SRP 全链路：正确密码通过服务端独立复算验签', async () => {
  const server = new FakeCognitoServer({
    userPoolId: POOL_ID,
    users: { 'zhang@example.com': { password: 'Sup3r!Pass', groups: ['PlatformSuperAdmin'] } },
  });
  const ephemeral = generateSrpEphemeral(() => new Uint8Array(128).fill(7));

  const challenge = await server.fetch('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: 'client-1',
    AuthParameters: { USERNAME: 'zhang@example.com', SRP_A: ephemeral.srpAHex },
  });
  assert.equal(challenge.status, 200);
  const body = challenge.body as {
    ChallengeName: string;
    ChallengeParameters: Record<string, string>;
    Session: string;
  };
  assert.equal(body.ChallengeName, 'PASSWORD_VERIFIER');

  const claim = await computePasswordVerifierClaim(ephemeral, {
    userPoolId: POOL_ID,
    userIdForSrp: body.ChallengeParameters['USER_ID_FOR_SRP'] as string,
    password: 'Sup3r!Pass',
    saltHex: body.ChallengeParameters['SALT'] as string,
    srpBHex: body.ChallengeParameters['SRP_B'] as string,
    secretBlockBase64: body.ChallengeParameters['SECRET_BLOCK'] as string,
    now: () => new Date(Date.UTC(2026, 8, 6, 10, 20, 30)),
  });

  const verdict = await server.fetch('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: 'client-1',
    ChallengeResponses: {
      USERNAME: 'zhang@example.com',
      PASSWORD_CLAIM_SECRET_BLOCK: body.ChallengeParameters['SECRET_BLOCK'] as string,
      TIMESTAMP: claim.timestamp,
      PASSWORD_CLAIM_SIGNATURE: claim.passwordClaimSignature,
    },
    Session: body.Session,
  });
  assert.equal(verdict.status, 200);
  assert.ok((verdict.body as Record<string, unknown>)['AuthenticationResult']);
});

test('SRP 全链路：错误密码服务端验签失败（NotAuthorizedException）', async () => {
  const server = new FakeCognitoServer({
    userPoolId: POOL_ID,
    users: { 'zhang@example.com': { password: 'Sup3r!Pass', groups: ['PlatformSuperAdmin'] } },
  });
  const ephemeral = generateSrpEphemeral(() => new Uint8Array(128).fill(9));
  const challenge = await server.fetch('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: 'client-1',
    AuthParameters: { USERNAME: 'zhang@example.com', SRP_A: ephemeral.srpAHex },
  });
  const body = challenge.body as { ChallengeParameters: Record<string, string>; Session: string };
  const claim = await computePasswordVerifierClaim(ephemeral, {
    userPoolId: POOL_ID,
    userIdForSrp: body.ChallengeParameters['USER_ID_FOR_SRP'] as string,
    password: 'wrong-password',
    saltHex: body.ChallengeParameters['SALT'] as string,
    srpBHex: body.ChallengeParameters['SRP_B'] as string,
    secretBlockBase64: body.ChallengeParameters['SECRET_BLOCK'] as string,
  });
  const verdict = await server.fetch('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: 'client-1',
    ChallengeResponses: {
      USERNAME: 'zhang@example.com',
      PASSWORD_CLAIM_SECRET_BLOCK: body.ChallengeParameters['SECRET_BLOCK'] as string,
      TIMESTAMP: claim.timestamp,
      PASSWORD_CLAIM_SIGNATURE: claim.passwordClaimSignature,
    },
    Session: body.Session,
  });
  assert.equal(verdict.status, 400);
  assert.equal((verdict.body as Record<string, unknown>)['__type'], 'NotAuthorizedException');
});

test('失败关闭：服务端公钥 B ≡ 0 mod N 拒绝', async () => {
  const ephemeral = generateSrpEphemeral(() => new Uint8Array(128).fill(3));
  await expectRejects(
    computePasswordVerifierClaim(ephemeral, {
      userPoolId: POOL_ID,
      userIdForSrp: 'user-1',
      password: 'x',
      saltHex: 'aa55',
      srpBHex: SRP_N_HEX,
      secretBlockBase64: Buffer.from('block').toString('base64'),
    }),
    (error) => assert.instanceOf(error, SrpError),
  );
});

test('确定性注入：同一随机源产生同一公钥 A', () => {
  const first = generateSrpEphemeral(() => new Uint8Array(128).fill(1));
  const second = generateSrpEphemeral(() => new Uint8Array(128).fill(1));
  assert.equal(first.srpAHex, second.srpAHex);
  const third = generateSrpEphemeral(() => new Uint8Array(128).fill(2));
  assert.notEqual(first.srpAHex, third.srpAHex);
});
