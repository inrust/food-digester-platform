/**
 * BE-DUSR-02 设备本地密码验证值生成器验收（纯函数管线，无需数据库）。
 *
 * 范围（DEC-004 provisional，KDF 参数 fail-closed）：
 * - KDF adapter 接口 + 生成管线语义：每用户独立随机 salt（不同 salt 结果不同）；
 *   注入固定 salt 源时输出确定可复验（管线语义验证，非 DEC-004 冻结测试向量——
 *   固定测试向量待冻结后由冻结 adapter 补齐）；
 * - 策略查询为注入门面：provisional 期间抛 PolicyParameterPendingError → 生成失败关闭；
 * - adapter/策略 kdfId 错配 → CONFLICT；空密码 → VALIDATION_FAILED；
 * - 脱敏管线：redactVerifierSecrets / assertNoVerifierLeak；DTO 四字段与 DEC-004 一致；
 * - 不得使用云端密码 Hash：管线输入为明文密码 + 独立 salt，输出与任何云端材料无关。
 */
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import { assert } from 'vitest';
import {
  VERIFIER_ERROR_HTTP_STATUS,
  VERIFIER_MATERIAL_FIELDS,
  VERIFIER_REDACTED,
  VerifierError,
  assertNoVerifierLeak,
  generateVerifierMaterial,
  redactVerifierSecrets,
} from '../src/index.js';
import type { GeneratedVerifierMaterial, VerifierKdfAdapter, VerifierPolicyQuery } from '../src/index.js';

// ---------- 测试夹具：模拟冻结后的策略与 adapter（仅验证管线语义，非冻结测试向量） ----------

const FROZEN_SIM_POLICY: VerifierPolicyQuery = {
  getVerifierKdf: () => 'TEST-SHA256-KDF',
  getVerifierKdfParameters: () => ({ iterations: 1 }),
  getVerifierSaltBytes: () => 16,
  getVerifierHashBytes: () => 32,
};

function testAdapter(kdfId = 'TEST-SHA256-KDF'): VerifierKdfAdapter {
  return {
    kdfId,
    materialVersion: 'v1',
    derive: ({ password, salt, hashBytes }) =>
      createHash('sha256').update(salt).update(password, 'utf8').digest().subarray(0, hashBytes),
  };
}

/** 模拟 provisional 策略：参数读取失败关闭（语义同 PolicyParameterPendingError）。 */
class SimulatedPendingError extends Error {
  override readonly name = 'PolicyParameterPendingError';
  constructor(parameter: string) {
    super(`POLICY_PARAMETER_PENDING: ${parameter}`);
  }
}

const PROVISIONAL_POLICY: VerifierPolicyQuery = {
  getVerifierKdf: () => {
    throw new SimulatedPendingError('material.kdf');
  },
  getVerifierKdfParameters: () => {
    throw new SimulatedPendingError('material.kdfParameters');
  },
  getVerifierSaltBytes: () => {
    throw new SimulatedPendingError('material.saltBytes');
  },
  getVerifierHashBytes: () => {
    throw new SimulatedPendingError('material.hashBytes');
  },
};

function throwsWith(fn: () => unknown, pattern: RegExp): Error {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, pattern);
    return err;
  }
  assert.fail(`应抛出 ${pattern}`);
}

describe('验证材料生成管线（模拟冻结 adapter）', () => {
  test('输出 DEC-004 固定四字段；salt/hash 为 base64 且长度符合策略', () => {
    const material = generateVerifierMaterial({ policy: FROZEN_SIM_POLICY, adapter: testAdapter() }, 'pw-123');
    assert.deepEqual(Object.keys(material).sort(), [...VERIFIER_MATERIAL_FIELDS].sort());
    assert.equal(material.kdf, 'TEST-SHA256-KDF');
    assert.equal(material.version, 'v1');
    assert.equal(Buffer.from(material.salt, 'base64').length, 16);
    assert.equal(Buffer.from(material.hash, 'base64').length, 32);
    assert.ok(!JSON.stringify(material).includes('pw-123'), 'DTO 不含明文密码');
  });

  test('每用户独立随机 salt：同密码两次生成结果不同', () => {
    const deps = { policy: FROZEN_SIM_POLICY, adapter: testAdapter() };
    const a = generateVerifierMaterial(deps, 'same-password');
    const b = generateVerifierMaterial(deps, 'same-password');
    assert.notEqual(a.salt, b.salt, 'CSPRNG 独立 salt');
    assert.notEqual(a.hash, b.hash, '不同 salt 结果必须不同');
  });

  test('注入固定 salt 源：输出确定可复验（管线语义，设备方可重算）', () => {
    const fixedSalt = Buffer.alloc(16, 7);
    const deps = { policy: FROZEN_SIM_POLICY, adapter: testAdapter(), randomBytes: () => fixedSalt };
    const a = generateVerifierMaterial(deps, 'device-local-pw');
    const b = generateVerifierMaterial(deps, 'device-local-pw');
    assert.deepEqual(a, b, '同输入同 salt 确定性输出');
    // 设备方复验路径：独立重算（不经生成器）应得到相同 hash
    const expected = createHash('sha256').update(fixedSalt).update('device-local-pw', 'utf8').digest();
    assert.equal(a.hash, expected.toString('base64'));
    assert.equal(a.salt, fixedSalt.toString('base64'));
  });

  test('adapter 与策略 kdfId 错配 → CONFLICT；空密码 → VALIDATION_FAILED', () => {
    const err = throwsWith(
      () => generateVerifierMaterial({ policy: FROZEN_SIM_POLICY, adapter: testAdapter('WRONG-KDF') }, 'pw-123456'),
      /does not match/,
    );
    assert.ok(err instanceof VerifierError);
    assert.equal((err as VerifierError).code, 'CONFLICT');

    for (const bad of ['', '   ']) {
      const e = throwsWith(
        () => generateVerifierMaterial({ policy: FROZEN_SIM_POLICY, adapter: testAdapter() }, bad),
        /non-empty/,
      );
      assert.equal((e as VerifierError).code, 'VALIDATION_FAILED');
    }
  });

  test('salt/hash 长度不符合策略 → CONFLICT（防 adapter 实现漂移）', () => {
    const shortSalt = {
      policy: FROZEN_SIM_POLICY,
      adapter: testAdapter(),
      randomBytes: (n: number) => Buffer.alloc(n - 1),
    };
    throwsWith(() => generateVerifierMaterial(shortSalt, 'pw-123456'), /salt source returned/);
  });
});

describe('DEC-004 冻结前失败关闭', () => {
  test('provisional 策略参数读取抛 PolicyParameterPendingError，生成器不兜底（透传）', () => {
    for (const pw of ['pw-123456']) {
      const err = throwsWith(
        () => generateVerifierMaterial({ policy: PROVISIONAL_POLICY, adapter: testAdapter() }, pw),
        /POLICY_PARAMETER_PENDING: material\.kdf/,
      );
      assert.equal(err.name, 'PolicyParameterPendingError');
    }
  });

  test('错误码目录仅含 VALIDATION_FAILED/CONFLICT 且对齐 CT-05', () => {
    assert.deepEqual(VERIFIER_ERROR_HTTP_STATUS, { VALIDATION_FAILED: 400, CONFLICT: 409 });
  });
});

describe('脱敏管线', () => {
  const material: GeneratedVerifierMaterial = {
    version: 'v1',
    kdf: 'TEST-SHA256-KDF',
    salt: 'c2FsdC1leGFtcGxlLTEyMw==',
    hash: 'aGFzaC1leGFtcGxlLTQ1Ng==',
  };
  const secrets = [material.hash, material.salt, 'device-local-pw'];

  test('redactVerifierSecrets 替换 hash/salt/明文密码；普通文本不受影响', () => {
    const log = `rotate user=u1 hash=${material.hash} salt=${material.salt} pw=device-local-pw done`;
    const redacted = redactVerifierSecrets(log, secrets);
    assert.ok(!redacted.includes(material.hash));
    assert.ok(!redacted.includes(material.salt));
    assert.ok(!redacted.includes('device-local-pw'));
    assert.ok(redacted.includes(VERIFIER_REDACTED));
    assert.ok(redacted.includes('user=u1'), '非敏感内容保留');

    const clean = 'audit: device-user.update user=u1';
    assert.equal(redactVerifierSecrets(clean, secrets), clean);
  });

  test('assertNoVerifierLeak：含材料抛错；干净文本通过', () => {
    assert.doesNotThrow(() => assertNoVerifierLeak('clean audit payload', secrets));
    const err = throwsWith(() => assertNoVerifierLeak(`leak ${material.hash}`, secrets), /verifier material/);
    assert.equal((err as VerifierError).code, 'VALIDATION_FAILED');
  });

  test('短于 8 字符的值不参与脱敏比对（避免误伤普通文本）；去重与长串优先', () => {
    assert.equal(redactVerifierSecrets('abc def', ['abc', '']), 'abc def');
    const out = redactVerifierSecrets('x=aaaaaaaaaaaa y=aaaaaaaa', ['aaaaaaaa', 'aaaaaaaaaaaa']);
    assert.equal(out, `x=${VERIFIER_REDACTED} y=${VERIFIER_REDACTED}`);
  });
});
