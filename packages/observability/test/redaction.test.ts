/**
 * SEC-01 脱敏中间件测试：字段名 + 值形态双层防线；公钥证书不误伤。
 */
import { assert, describe, test } from 'vitest';
import { createRedactingLogger, redactSensitive, redactString, REDACTED } from '../src/index.js';

// PEM 标记以拼接构造，避免本文件命中 check-secrets 门禁（ENG-02 §5 约定）
const PRIVATE_KEY_PEM = [
  ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC',
  ['-----END', 'PRIVATE KEY-----'].join(' '),
].join('\n');
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';
const ONBOARDING_TOKEN = 'fdp_onb_abcdefghijklmnopqrstuvwxyz-abcdefghijklmnop';

describe('redactSensitive 双层脱敏', () => {
  test('字段名命中整体遮蔽（不区分大小写）', () => {
    const out = redactSensitive({
      privateKey: 'abc',
      Password: 'x',
      nested: { accessKey: 'y', note: 'ok' },
    }) as Record<string, unknown>;
    assert.equal(out.privateKey, REDACTED);
    assert.equal(out.Password, REDACTED);
    assert.equal((out.nested as Record<string, unknown>).accessKey, REDACTED);
    assert.equal((out.nested as Record<string, unknown>).note, 'ok');
  });

  test('值形态脱敏：私钥块在任意字段名下都被遮蔽', () => {
    const out = redactSensitive({ note: `payload: ${PRIVATE_KEY_PEM} end` }) as Record<string, unknown>;
    const note = out.note as string;
    assert.notInclude(note, 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC');
    assert.include(note, REDACTED);
  });

  test('Onboarding Token 明文与 Bearer 凭证被遮蔽', () => {
    assert.equal(redactString(`token=${ONBOARDING_TOKEN}`), `token=${REDACTED}`);
    assert.equal(redactString('Authorization: Bearer abc.def.ghi'), `Authorization: ${REDACTED}`);
  });

  test('公钥证书 PEM 不误遮蔽', () => {
    assert.equal(redactString(CERT_PEM), CERT_PEM);
  });

  test('Error message 脱敏且保留错误类型', () => {
    const err = new Error(`claim failed for ${ONBOARDING_TOKEN}`);
    const out = redactSensitive(err) as Error;
    assert.instanceOf(out, Error);
    assert.notInclude(out.message, ONBOARDING_TOKEN);
    assert.include(out.message, REDACTED);
  });

  test('数组与嵌套对象递归处理', () => {
    const out = redactSensitive([{ token: 'x' }, [`${PRIVATE_KEY_PEM}`]]) as unknown[];
    assert.equal((out[0] as Record<string, unknown>).token, REDACTED);
    assert.equal((out[1] as string[])[0], REDACTED);
  });
});

describe('createRedactingLogger', () => {
  test('所有级别输出均脱敏', () => {
    const captured: unknown[][] = [];
    const base = {
      debug: (...args: unknown[]) => captured.push(args),
      info: (...args: unknown[]) => captured.push(args),
      warn: (...args: unknown[]) => captured.push(args),
      error: (...args: unknown[]) => captured.push(args),
    };
    const logger = createRedactingLogger(base);
    logger.info('storing package', { privateKey: PRIVATE_KEY_PEM });
    logger.error(new Error(`claim with ${ONBOARDING_TOKEN}`));

    const serialized = JSON.stringify(captured, (_, v: unknown) => (v instanceof Error ? v.message : v));
    assert.notInclude(serialized, 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASC');
    assert.notInclude(serialized, ONBOARDING_TOKEN);
  });
});
