/**
 * BE-ONB-02 与 CT-05 契约一致性 + 无 AWS 副作用证据。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';
import { ADMIN_ONBOARDING_ERROR_HTTP_STATUS, toDto } from '../src/index.js';
import type { AdminOnboardingRequestRecord } from '../src/index.js';

const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);

function loadJson(name: string) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));
}

test('AdminOnboardingError 错误码与 CT-05 错误码目录一致', () => {
  const catalog = new Map<string, number>(
    (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
      e.code,
      e.httpStatus,
    ]),
  );
  for (const [code, status] of Object.entries(ADMIN_ONBOARDING_ERROR_HTTP_STATUS)) {
    assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
  }
});

test('DTO 字段与 OpenAPI OnboardingRequest 契约一致且不含 tokenId', () => {
  const api = loadJson('admin-onboarding-api.json');
  const schema = api.components.schemas.OnboardingRequest;
  const record: AdminOnboardingRequestRecord = {
    id: 'req-1',
    serialNumber: 'SN-1',
    submittedBy: 'DEVICE:SN-1',
    model: 'BNX-100',
    hardwareVersion: 'HW1.0',
    manufacturer: 'Hiddenjoy',
    manufactureDate: new Date('2026-01-01T00:00:00Z'),
    status: 'REJECTED',
    rejectReason: 'r',
    reviewedBy: 'admin-1',
    reviewedAt: new Date('2026-08-27T08:00:00Z'),
    version: 2,
    createdAt: new Date('2026-08-26T08:00:00Z'),
    provisioningJob: { status: 'FAILED' },
  };
  const dto = toDto(record);
  assert.deepEqual(Object.keys(dto).sort(), [...schema.required].sort());
  assert.ok(!('tokenId' in dto));
  assert.equal(dto.manufactureDate, '2026-01-01');
  assert.equal(dto.reviewedAt, '2026-08-27T08:00:00.000Z');
  assert.equal(dto.certificateProvisioningStatus, 'NOT_APPLICABLE');
});

test('admin/onboarding 模块无任何 AWS 依赖', () => {
  const dir = fileURLToPath(new URL('../src/admin/onboarding/', import.meta.url));
  for (const file of readdirSync(dir)) {
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
  }
});
