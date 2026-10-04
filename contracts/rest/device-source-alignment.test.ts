/**
 * Device-Cloud Communication Design §6（解析文档 line 431）跨文件一致性检查。
 * 锁定源稿定义的 6 个设备 REST Endpoint；Onboarding 认证与证书字段
 * 按业务方/设备方批准的 DEC-025 偏离源稿，其余接口仍与源稿对齐。
 * 源稿未定义的管理端 API 不参与路径集合比较。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));

const onboarding = load('device-onboarding-api.json');
const certificate = load('device-certificate-api.json');
const sync = load('device-sync-api.json');
const deactivate = load('device-deactivate-api.json');
const adminConfiguration = load('admin-configuration-api.json');
const adminLicense = load('admin-license-api.json');
const adminDevice = load('admin-device-api.json');
const contractVersion = JSON.parse(readFileSync(new URL('../contract-version.json', import.meta.url), 'utf8'));

test('六个设备 Endpoint 的 Method、Path 完整且认证方式符合 DEC-025', () => {
  const expected = [
    ['POST', '/api/v1/device/onboarding/request', undefined],
    ['GET', '/api/v1/device/onboarding/status', undefined],
    ['POST', '/api/v1/device/certificate/rotate', 'DeviceMtls'],
    ['GET', '/api/v1/device/certificate/status', 'DeviceMtls'],
    ['POST', '/api/v1/device/sync', 'DeviceMtls'],
    ['POST', '/api/v1/device/deactivate', 'DeviceMtls'],
  ];
  const actual: string[][] = [];
  for (const doc of [onboarding, certificate, sync, deactivate]) {
    for (const [path, pathItem] of Object.entries(doc.paths) as [string, Record<string, any>][]) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
        const op = pathItem[method];
        if (!op) continue;
        const auth = Object.keys(op.security?.[0] ?? {})[0];
        actual.push([method.toUpperCase(), path, auth]);
      }
    }
  }
  assert.deepEqual(actual.sort(), expected.sort());
  assert.ok(onboarding.info['x-decision-versions'].includes('DEC-025@1.1.0'));
});

test('Onboarding 按 DEC-026 增加 chain 与 REST，保留顶层结构，不使用 data/meta 包裹', () => {
  const requestResult = onboarding.components.schemas.OnboardingRequestResult;
  assert.deepEqual(requestResult.required, ['requestId', 'status']);

  const rejected = onboarding.components.schemas.OnboardingStatusRejected;
  assert.deepEqual(rejected.required, ['status', 'reason']);

  const approved = onboarding.components.schemas.OnboardingStatusApproved;
  assert.deepEqual(approved.required, ['status', 'deviceId', 'certificate', 'mqtt', 'configuration', 'rest']);
  assert.deepEqual(onboarding.components.schemas.OnboardingCertificate.required, [
    'certificatePem',
    'certificateChain',
  ]);
  assert.deepEqual(onboarding.components.schemas.OnboardingMqtt.required, ['endpoint']);
  assert.deepEqual(onboarding.components.schemas.OnboardingInitialConfiguration.required, ['heartbeatInterval']);
});

test('Certificate 与 Sync 关键字段遵循源稿日期、枚举、用户和配置结构', () => {
  const rotate = certificate.components.schemas.CertificateRotateResult;
  assert.equal(rotate.properties.effectiveDate.format, 'date');
  assert.equal(rotate.properties.expiryDate.format, 'date');

  const license = sync.components.schemas.SyncLicense;
  assert.ok(license.properties.status.enum.includes('ACTIVE'));
  assert.deepEqual(license.properties.entitlements.items.enum, ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING']);
  assert.deepEqual(license.properties.signature.type, ['string', 'null']); // Draft 尚未签发；已签发仍为字符串。
  assert.equal(adminLicense.components.schemas.LicenseCreateRequest.properties.validFrom.format, 'date');
  assert.equal(adminLicense.components.schemas.License.properties.validTo.format, 'date');
  assert.equal(adminDevice.components.schemas.DeviceLicenseSummary.properties.validFrom.format, 'date');

  const user = sync.components.schemas.SyncDeviceUser;
  assert.deepEqual(user.required, ['userId', 'username', 'displayName', 'passwordHash', 'status']);

  const expectedConfiguration = [
    'heartbeatInterval',
    'telemetryInterval',
    'cameraRefreshInterval',
    'temperatureThreshold',
  ];
  assert.deepEqual(sync.components.schemas.SyncConfiguration.required, expectedConfiguration);
  assert.deepEqual(adminConfiguration.components.schemas.ConfigurationPayload.required, expectedConfiguration);
  assert.ok(!deactivate.paths['/api/v1/device/deactivate'].post.requestBody);
});

test('管理端 License/Device 投影不把源稿 OTA entitlement 改名为 OTA_UPDATE', () => {
  assert.deepEqual(adminLicense.components.schemas.LicenseEntitlement.properties.code.enum, [
    'REMOTE_CONTROL',
    'OTA',
    'ESG_REPORTING',
  ]);
  assert.deepEqual(adminDevice.components.schemas.DeviceLicenseSummary.properties.entitlements.items.enum, [
    'REMOTE_CONTROL',
    'OTA',
    'ESG_REPORTING',
  ]);
});

test('所有 REST OpenAPI 使用当前正式决策登记版本且无非法 SEC 决策引用', () => {
  const files = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const file of files) {
    const doc = load(file);
    if (!doc.openapi) continue;
    assert.equal(
      doc.info['x-decision-register-version'],
      contractVersion.decisionRegisterVersion,
      `${file} 决策登记版本过期`,
    );
    for (const ref of doc.info['x-decision-versions'] ?? []) {
      assert.ok(!ref.startsWith('SEC-'), `${file} 含非法决策引用 ${ref}`);
    }
  }
});
