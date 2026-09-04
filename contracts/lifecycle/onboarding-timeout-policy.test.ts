import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';
import {
  ONBOARDING_TIMEOUT_POLICY,
  isOnboardingDeadlineReached,
  onboardingDeadlineFrom,
} from './onboarding-timeout-policy.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const json = read('./onboarding-timeout-policy.json');
const schema = read('./onboarding-timeout-policy.schema.json');
const register = read('../decisions/decision-register.json');

test('DEC-017 策略结构有效、已冻结且覆盖全部阻塞任务', () => {
  assert.deepEqual(validate(schema, 'onboarding-timeout-policy.schema.json', json, new SchemaRegistry('.')), []);
  const decision = register.decisions.find((item: { id: string }) => item.id === 'DEC-017');
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.ok(json['x-decision-versions'].includes('DEC-017@1.0.0'));
  assert.deepEqual(new Set(json.consumers), new Set(decision.blockingTasks));
  assert.deepEqual(json.pendingParameters, []);
});

test('24 小时截止从证书包存储开始，截止边界包含在超时内', () => {
  const storedAt = new Date('2026-09-04T00:00:00Z');
  const deadline = onboardingDeadlineFrom(storedAt);
  assert.equal(deadline.toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(isOnboardingDeadlineReached(deadline, new Date('2026-09-04T23:59:59.999Z')), false);
  assert.equal(isOnboardingDeadlineReached(deadline, deadline), true);
});

test('超时处置、迟到 Heartbeat 与重新申请规则失败关闭', () => {
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.internalRequestStatus, 'TIMED_OUT');
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus, 'REJECTED');
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason, 'ONBOARDING_TIMEOUT');
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.certificateStatus, 'REVOKED');
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.beforeDeadlinePackageExpiry, 'REVOKE_AND_RESIGN');
  assert.equal(ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.afterDeadlineAutomaticResign, false);
  assert.equal(ONBOARDING_TIMEOUT_POLICY.lateHeartbeat, 'REJECT');
  assert.deepEqual(ONBOARDING_TIMEOUT_POLICY.retry, { requiresNewToken: true, requiresNewRequest: true });
});

test('TS 常量与 JSON 策略一致', () => {
  assert.equal(json.policyVersion, ONBOARDING_TIMEOUT_POLICY.policyVersion);
  assert.deepEqual(json.deadline, ONBOARDING_TIMEOUT_POLICY.deadline);
  assert.deepEqual(json.timeoutDisposition, ONBOARDING_TIMEOUT_POLICY.timeoutDisposition);
  assert.equal(json.lateHeartbeat, ONBOARDING_TIMEOUT_POLICY.lateHeartbeat);
  assert.deepEqual(json.retry, ONBOARDING_TIMEOUT_POLICY.retry);
  assert.deepEqual(json.consumers, [...ONBOARDING_TIMEOUT_POLICY.consumers]);
});
