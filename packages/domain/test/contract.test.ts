/**
 * BE-CON-01 Contract 状态领域规则单测：窗口校验、状态机、时间派生、续约、编辑前置。
 */
import { assert, describe, test } from 'vitest';
import {
  CONTRACT_EXPIRING_SOON_WINDOW_DAYS,
  ContractStateError,
  assertContractActivatable,
  assertContractEditable,
  assertContractTerminatable,
  assertContractWindow,
  deriveContractStatus,
  evaluateContractAt,
  renewContractWindow,
} from '../src/index.js';
import type { ContractSnapshot } from '../src/index.js';

const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2027-01-01T00:00:00Z');
const NOW = new Date('2026-06-01T00:00:00Z');
const DAY = 86_400_000;

function snap(status: ContractSnapshot['status'], endAt: Date = END): ContractSnapshot {
  return { status, startAt: START, endAt };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ContractStateError);
    return err.code;
  }
  assert.fail('should throw ContractStateError');
}

describe('窗口校验', () => {
  test('startAt < endAt 合法；相等/倒置/非法时间拒绝', () => {
    assert.doesNotThrow(() => assertContractWindow(START, END));
    assert.equal(
      codeOf(() => assertContractWindow(END, END)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertContractWindow(END, START)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertContractWindow(new Date(NaN), END)),
      'VALIDATION_FAILED',
    );
  });
});

describe('时间派生（evaluateContractAt / deriveContractStatus）', () => {
  test('EFFECTIVE → EXPIRING_SOON（窗口内）→ EXPIRED（到期）', () => {
    assert.equal(deriveContractStatus(snap('EFFECTIVE'), NOW), 'EFFECTIVE');
    const soonAt = new Date(END.getTime() - (CONTRACT_EXPIRING_SOON_WINDOW_DAYS - 1) * DAY);
    assert.equal(deriveContractStatus(snap('EFFECTIVE'), soonAt), 'EXPIRING_SOON');
    assert.equal(deriveContractStatus(snap('EXPIRING_SOON'), new Date(END.getTime())), 'EXPIRED');
    assert.equal(deriveContractStatus(snap('EFFECTIVE'), new Date(END.getTime() + DAY)), 'EXPIRED');
  });

  test('无变化返回 null；DRAFT/TERMINATED 不派生；EXPIRED 粘性（仅经 renew 离开）', () => {
    assert.equal(evaluateContractAt(snap('EFFECTIVE'), NOW), null);
    assert.equal(evaluateContractAt(snap('DRAFT'), new Date(END.getTime() + DAY)), null);
    assert.equal(evaluateContractAt(snap('TERMINATED'), new Date(END.getTime() + DAY)), null);
    assert.equal(evaluateContractAt(snap('EXPIRED'), new Date(END.getTime() + DAY)), null);
    // EXPIRED 粘性：读取时点早于 endAt（时间注入复验场景）也不回退
    assert.equal(deriveContractStatus(snap('EXPIRED'), NOW), 'EXPIRED');
    assert.equal(evaluateContractAt(snap('EFFECTIVE'), new Date(END.getTime() - 5 * DAY)), 'EXPIRING_SOON');
  });
});

describe('显式动作前置', () => {
  test('仅 DRAFT 可激活；TERMINATED 不可终止/编辑；DRAFT 外不可改窗口', () => {
    assert.doesNotThrow(() => assertContractActivatable('DRAFT'));
    assert.equal(
      codeOf(() => assertContractActivatable('EFFECTIVE')),
      'CONFLICT',
    );
    assert.doesNotThrow(() => assertContractTerminatable('EFFECTIVE'));
    assert.equal(
      codeOf(() => assertContractTerminatable('TERMINATED')),
      'CONFLICT',
    );
    assert.equal(
      codeOf(() => assertContractEditable('TERMINATED', { touchesStartAt: false, touchesEndAt: false })),
      'CONFLICT',
    );
    assert.equal(
      codeOf(() => assertContractEditable('EFFECTIVE', { touchesStartAt: false, touchesEndAt: true })),
      'CONFLICT',
    );
    assert.doesNotThrow(() => assertContractEditable('EFFECTIVE', { touchesStartAt: false, touchesEndAt: false }));
    assert.doesNotThrow(() => assertContractEditable('DRAFT', { touchesStartAt: true, touchesEndAt: true }));
  });
});

describe('续约', () => {
  test('EFFECTIVE/EXPIRING_SOON/EXPIRED 可续约；状态按新窗口重推导', () => {
    const newEnd = new Date(END.getTime() + 365 * DAY);
    assert.equal(renewContractWindow(snap('EFFECTIVE'), newEnd, NOW), 'EFFECTIVE');
    assert.equal(renewContractWindow(snap('EXPIRED'), newEnd, NOW), 'EFFECTIVE');
    // 新窗口仍在到期窗口内 → EXPIRING_SOON
    const nearEnd = new Date(NOW.getTime() + 10 * DAY);
    assert.equal(
      renewContractWindow(snap('EXPIRING_SOON', new Date(NOW.getTime() + 2 * DAY)), nearEnd, NOW),
      'EXPIRING_SOON',
    );
  });

  test('DRAFT/TERMINATED 不可续约；newEndAt 必须更晚', () => {
    assert.equal(
      codeOf(() => renewContractWindow(snap('DRAFT'), new Date(END.getTime() + DAY), NOW)),
      'CONFLICT',
    );
    assert.equal(
      codeOf(() => renewContractWindow(snap('TERMINATED'), new Date(END.getTime() + DAY), NOW)),
      'CONFLICT',
    );
    assert.equal(
      codeOf(() => renewContractWindow(snap('EFFECTIVE'), END, NOW)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => renewContractWindow(snap('EFFECTIVE'), new Date(END.getTime() - DAY), NOW)),
      'VALIDATION_FAILED',
    );
  });
});
