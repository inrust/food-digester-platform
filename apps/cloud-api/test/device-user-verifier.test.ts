/** DEC-004@1.0.0 Argon2id/PHC 生产实现与跨设备固定向量。 */
import { describe, expect, test } from 'vitest';
import { assert } from 'vitest';
import {
  DEVICE_USER_ARGON2_PARAMETERS,
  DEVICE_USER_PASSWORD_HASH_PATTERN,
  DEVICE_USER_SALT_BYTES,
  VERIFIER_ERROR_HTTP_STATUS,
  VERIFIER_REDACTED,
  VerifierError,
  assertDeviceUserPasswordHash,
  assertNoVerifierLeak,
  hashDeviceUserPassword,
  redactVerifierSecrets,
  verifyDeviceUserPassword,
} from '../src/index.js';

const VECTOR_PASSWORD = 'correct horse battery staple';
const VECTOR_SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const VECTOR_PHC = '$argon2id$v=19$m=32768,t=3,p=1$AAECAwQFBgcICQoLDA0ODw$u+TOcl2LGub4w/cLIdrGdoG/cbU//EuAXDXm+qRHfqs';

describe('DEC-004 冻结参数与固定向量', () => {
  test('参数严格为 Argon2id v=19、m=32768、t=3、p=1、salt=16、hash=32', () => {
    assert.equal(DEVICE_USER_ARGON2_PARAMETERS.version, 0x13);
    assert.equal(DEVICE_USER_ARGON2_PARAMETERS.memoryCost, 32_768);
    assert.equal(DEVICE_USER_ARGON2_PARAMETERS.timeCost, 3);
    assert.equal(DEVICE_USER_ARGON2_PARAMETERS.parallelism, 1);
    assert.equal(DEVICE_USER_ARGON2_PARAMETERS.hashLength, 32);
    assert.equal(DEVICE_USER_SALT_BYTES, 16);
  });

  test('固定向量生成确定 PHC，设备方可独立复验', async () => {
    assert.equal(await hashDeviceUserPassword(VECTOR_PASSWORD, VECTOR_SALT), VECTOR_PHC);
    assert.isTrue(await verifyDeviceUserPassword(VECTOR_PHC, VECTOR_PASSWORD));
    assert.isFalse(await verifyDeviceUserPassword(VECTOR_PHC, 'wrong-password'));
  });

  test('缺省 CSPRNG 为同密码生成不同 salt/hash', async () => {
    const a = await hashDeviceUserPassword('same-password');
    const b = await hashDeviceUserPassword('same-password');
    assert.match(a, DEVICE_USER_PASSWORD_HASH_PATTERN);
    assert.match(b, DEVICE_USER_PASSWORD_HASH_PATTERN);
    assert.notEqual(a, b);
  });

  test('非法 PHC、空密码和错误 salt 长度失败关闭', async () => {
    assert.throws(() => assertDeviceUserPasswordHash('$argon2id$v=19$m=1,t=1,p=1$x$y'), VerifierError);
    await expect(hashDeviceUserPassword('')).rejects.toThrow(/non-empty/);
    await expect(hashDeviceUserPassword('pw', Buffer.alloc(15))).rejects.toThrow(/16 bytes/);
    assert.isFalse(await verifyDeviceUserPassword('not-a-phc', 'pw'));
  });

  test('错误码目录对齐 CT-05', () => {
    assert.deepEqual(VERIFIER_ERROR_HTTP_STATUS, { VALIDATION_FAILED: 400, CONFLICT: 409 });
  });
});

describe('敏感材料脱敏', () => {
  const secrets = [VECTOR_PASSWORD, VECTOR_PHC];

  test('日志文本中的明文密码和 PHC 被整体遮蔽', () => {
    const redacted = redactVerifierSecrets(`pw=${VECTOR_PASSWORD} hash=${VECTOR_PHC}`, secrets);
    assert.notInclude(redacted, VECTOR_PASSWORD);
    assert.notInclude(redacted, VECTOR_PHC);
    assert.include(redacted, VERIFIER_REDACTED);
  });

  test('泄漏断言失败关闭，短普通值不误伤', () => {
    assert.throws(() => assertNoVerifierLeak(`hash=${VECTOR_PHC}`, secrets), VerifierError);
    assert.doesNotThrow(() => assertNoVerifierLeak('clean audit', secrets));
    assert.equal(redactVerifierSecrets('abc', ['abc']), 'abc');
  });
});
