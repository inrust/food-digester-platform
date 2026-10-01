import { describe, expect, test } from 'vitest';
import { assertOpenApiResponse } from './openapi-response.js';

describe('完整 OpenAPI response validator', () => {
  const status = {
    certificateId: 'cert-1',
    status: 'ACTIVE',
    expiryDate: '2027-01-01',
    daysRemaining: 116,
    mqttVerifiedAt: null,
    restVerifiedAt: null,
    rotationDeadlineAt: null,
    rotationConfirmedAt: null,
  };

  test('接受完整 Handler body 与 Lambda JSON body', () => {
    expect(() => assertOpenApiResponse('getCertificateStatus', 200, status)).not.toThrow();
    expect(() => assertOpenApiResponse('getCertificateStatus', 200, JSON.stringify(status))).not.toThrow();
  });

  test('缺字段、额外 envelope 与未知字段均失败', () => {
    expect(() => assertOpenApiResponse('getCertificateStatus', 200, { ...status, certificateId: undefined })).toThrow();
    expect(() => assertOpenApiResponse('getCertificateStatus', 200, { data: status })).toThrow();
    expect(() => assertOpenApiResponse('getCertificateStatus', 200, { ...status, unexpected: true })).toThrow();
  });
});
