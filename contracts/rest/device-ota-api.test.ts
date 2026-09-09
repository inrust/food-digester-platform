import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const doc = JSON.parse(readFileSync(new URL('./device-ota-api.json', import.meta.url), 'utf8'));
const operation = doc.paths['/api/v1/device/ota/targets/{targetId}/download'].get;

test('BE-OTA-03 下载兑换必须使用 Device mTLS 且绑定 target/token', () => {
  assert.equal(operation.operationId, 'redeemOtaDownloadGrant');
  assert.deepEqual(operation.security, [{ DeviceMtls: [] }]);
  const parameters = new Map(operation.parameters.map((parameter: { name: string }) => [parameter.name, parameter]));
  assert.equal((parameters.get('targetId') as { in: string; required: boolean }).in, 'path');
  assert.equal((parameters.get('targetId') as { required: boolean }).required, true);
  assert.equal((parameters.get('token') as { in: string; required: boolean }).in, 'query');
  assert.equal((parameters.get('token') as { required: boolean }).required, true);
});

test('一次性兑换响应禁止缓存，并封闭安全失败状态', () => {
  assert.equal(operation.responses['307'].headers['Cache-Control'].schema.const, 'no-store');
  assert.equal(operation.responses['307'].headers.Location.required, true);
  for (const status of ['400', '401', '403', '404', '409', '500']) {
    assert.ok(operation.responses[status], `缺少 ${status}`);
  }
});
