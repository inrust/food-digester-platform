import { assert, test } from 'vitest';
import { createApiClient } from '../src/api/http-client.js';
import type { ApiFetch, ApiFetchResponse } from '../src/api/http-client.js';
import type { SessionManager } from '../src/session/session-manager.js';
import {
  approveOnboardingRequest,
  fetchOnboardingRequest,
  fetchOnboardingRequests,
  rejectOnboardingRequest,
} from '../src/pages/onboarding/onboarding-api.js';

const SAFE_REQUEST = {
  requestId: 'req-1',
  serialNumber: 'SN-1',
  submittedBy: 'DEVICE:SN-1',
  model: 'FD-100',
  hardwareVersion: 'HW-1',
  manufacturer: 'BioNexa',
  manufactureDate: '2026-09-01',
  status: 'PENDING',
  rejectReason: null,
  reviewedBy: null,
  reviewedAt: null,
  version: 1,
  createdAt: '2026-09-10T00:00:00Z',
  certificateProvisioningStatus: 'NOT_STARTED',
} as const;

const SECRET_PATTERN = /private[_-]?key|begin [^-]*private key|token(?:id)?|packageciphertext/i;

test('Onboarding 四条管理链路的原始请求/响应 payload 不含私钥、Token 或证书包', async () => {
  const snapshots: unknown[] = [];
  const fetch: ApiFetch = async (url, init): Promise<ApiFetchResponse> => {
    const response = url.endsWith('/requests?status=PENDING')
      ? { data: [SAFE_REQUEST], meta: { nextCursor: null } }
      : { data: SAFE_REQUEST };
    snapshots.push({ url, method: init.method, body: init.body ?? null, response });
    return { status: 200, body: response };
  };
  const session = {
    ensureFreshAccessToken: async () => 'redacted-access-credential',
    clearSession: () => {},
  } as unknown as SessionManager;
  const api = createApiClient({ baseUrl: 'https://admin.invalid/api/v1', session, fetch });

  await fetchOnboardingRequests(api);
  await fetchOnboardingRequest(api, 'req-1');
  await approveOnboardingRequest(api, 'req-1', 1);
  await rejectOnboardingRequest(api, 'req-1', 1, 'inventory mismatch');

  assert.equal(snapshots.length, 4);
  assert.equal(SECRET_PATTERN.test(JSON.stringify(snapshots)), false);
});

test('传输快照探针能检出嵌套敏感字段，避免仅靠 DOM 假阴性', () => {
  const poisoned = { data: { requestId: 'req-1', certificate: { privateKey: 'must-not-cross-network' } } };
  assert.equal(SECRET_PATTERN.test(JSON.stringify(poisoned)), true);
});
