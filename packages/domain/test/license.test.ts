/**
 * DOM-02 License 状态机与商业规则测试。
 * 验收基准：无 Assignment 或无有效 License 时激活失败；续期、到期、撤销和重复请求均有确定结果。
 */
import { describe, expect, test } from 'vitest';
import {
  DeviceStateError,
  ENTITLEMENT_CODES,
  LICENSE_STATUSES,
  LICENSE_TRANSITIONS,
  LicenseStateError,
  assertDeviceRunnable,
  createLicenseDraft,
  evaluateLicenseAt,
  isLicenseEffective,
  renewLicense,
  transitionLicense,
  type LicenseActor,
  type LicenseSnapshot,
  type LicenseStatus,
} from '../src/index.js';

const ADMIN: LicenseActor = { actorType: 'ADMIN', actorId: 'admin-1', actorRole: 'PlatformOperator' };
const SUPER_ADMIN: LicenseActor = { actorType: 'ADMIN', actorId: 'admin-0', actorRole: 'PlatformSuperAdmin' };
const SYSTEM: LicenseActor = { actorType: 'SYSTEM', actorId: 'system' };
const DEVICE: LicenseActor = { actorType: 'DEVICE', actorId: 'dev-1' };

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2027-01-01T00:00:00Z');

function license(status: LicenseStatus, over: Partial<LicenseSnapshot> = {}): LicenseSnapshot {
  return Object.freeze({
    id: 'lic-1',
    deviceId: 'dev-1',
    status,
    validFrom: T0,
    validTo: T1,
    entitlements: [...ENTITLEMENT_CODES],
    ...over,
  });
}

describe('创建 Draft（NoLicense → Draft）', () => {
  test('合法创建成功，含历史与审计与 LICENSE_CHANGED 通知', () => {
    const effects = createLicenseDraft(
      {
        id: 'lic-1',
        deviceId: 'dev-1',
        customerId: 'cust-1',
        validFrom: T0,
        validTo: T1,
        entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE'],
        actor: SUPER_ADMIN,
      },
      { noOtherValidLicense: true },
    );
    expect(effects.to).toBe('Draft');
    expect(effects.historyEntry.fromStatus).toBeNull();
    expect(effects.notification).toEqual({ type: 'LICENSE_CHANGED', deviceId: 'dev-1' });
  });

  test('设备已存在有效 License 时拒绝创建（一个设备仅一个有效 License）', () => {
    expect(() =>
      createLicenseDraft(
        {
          id: 'lic-2',
          deviceId: 'dev-1',
          customerId: 'cust-1',
          validFrom: T0,
          validTo: T1,
          entitlements: ['REMOTE_CONTROL'],
          actor: SUPER_ADMIN,
        },
        { noOtherValidLicense: false },
      ),
    ).toThrow(LicenseStateError);
  });

  test('Entitlement 为空或含未知值被拒绝；非法有效期被拒绝', () => {
    const base = {
      id: 'lic-3',
      deviceId: 'dev-1',
      customerId: 'cust-1',
      validFrom: T0,
      validTo: T1,
      actor: SUPER_ADMIN,
    } as const;
    expect(() => createLicenseDraft({ ...base, entitlements: [] }, { noOtherValidLicense: true })).toThrow(
      /Entitlement 不能为空/,
    );
    expect(() =>
      createLicenseDraft({ ...base, entitlements: ['MAGIC' as never] }, { noOtherValidLicense: true }),
    ).toThrow(/未知 Entitlement/);
    expect(() =>
      createLicenseDraft(
        { ...base, validFrom: T1, validTo: T0, entitlements: ['OTA_UPDATE'] },
        { noOtherValidLicense: true },
      ),
    ).toThrow(/validFrom/);
  });
});

describe('文档状态路径全部成功', () => {
  test('Draft → Issued → Active → ExpiringSoon → Renewed → Active 全链路', () => {
    let current = license('Draft');
    const issue = transitionLicense(current, 'Issued', ADMIN);
    expect(issue.to).toBe('Issued');

    current = license('Issued');
    const activate = transitionLicense(current, 'Active', DEVICE);
    expect(activate.to).toBe('Active');
    expect(activate.notification.type).toBe('LICENSE_CHANGED');

    current = license('Active');
    const expiring = transitionLicense(current, 'ExpiringSoon', SYSTEM);
    expect(expiring.to).toBe('ExpiringSoon');

    current = license('ExpiringSoon');
    const renewed = renewLicense(current, new Date('2028-01-01T00:00:00Z'), ADMIN);
    expect(renewed.to).toBe('Renewed');

    const reactivated = transitionLicense(license('Renewed'), 'Active', SYSTEM);
    expect(reactivated.to).toBe('Active');
  });

  test('Active → Expired、ExpiringSoon → Expired、Active/Expired → Revoked', () => {
    expect(transitionLicense(license('Active'), 'Expired', SYSTEM).to).toBe('Expired');
    expect(transitionLicense(license('ExpiringSoon'), 'Expired', SYSTEM).to).toBe('Expired');
    expect(transitionLicense(license('Active'), 'Revoked', SUPER_ADMIN, { reason: '违约' }).to).toBe('Revoked');
    expect(transitionLicense(license('Expired'), 'Revoked', ADMIN, { reason: '清理' }).to).toBe('Revoked');
  });
});

describe('非法迁移与执行者', () => {
  test('穷举：未列出的迁移全部失败', () => {
    for (const from of LICENSE_STATUSES) {
      for (const to of LICENSE_STATUSES) {
        const allowed = LICENSE_TRANSITIONS[from].some((r) => r.to === to);
        if (allowed) continue;
        expect(() => transitionLicense(license(from), to, SUPER_ADMIN, { reason: 'r' }), `${from} → ${to}`).toThrow(
          LicenseStateError,
        );
      }
    }
  });

  test('Revoked 为终态', () => {
    expect(LICENSE_TRANSITIONS.Revoked).toEqual([]);
  });

  test('发放/续期/撤销仅管理员；激活仅 SYSTEM/DEVICE', () => {
    expect(() => transitionLicense(license('Draft'), 'Issued', DEVICE)).toThrow(LicenseStateError);
    expect(() => transitionLicense(license('Issued'), 'Active', ADMIN)).toThrow(LicenseStateError);
    expect(() => transitionLicense(license('Active'), 'Revoked', SUPER_ADMIN, {})).toThrow(/原因/);
  });
});

describe('到期派生 evaluateAt（可注入时间）', () => {
  test('超过 validTo → Expired；进入 30 天窗口 → ExpiringSoon；窗口外不变', () => {
    const active = license('Active');
    expect(evaluateLicenseAt(active, new Date('2027-01-02T00:00:00Z'))!.to).toBe('Expired');
    expect(evaluateLicenseAt(active, new Date('2026-12-15T00:00:00Z'))!.to).toBe('ExpiringSoon');
    expect(evaluateLicenseAt(active, new Date('2026-06-01T00:00:00Z'))).toBeNull();
  });

  test('ExpiringSoon 超过 validTo → Expired；其他状态不随时间变化', () => {
    expect(evaluateLicenseAt(license('ExpiringSoon'), new Date('2027-02-01T00:00:00Z'))!.to).toBe('Expired');
    expect(evaluateLicenseAt(license('Draft'), new Date('2028-01-01T00:00:00Z'))).toBeNull();
    expect(evaluateLicenseAt(license('Revoked'), new Date('2028-01-01T00:00:00Z'))).toBeNull();
  });

  test('重复求值结果确定（幂等）', () => {
    const active = license('Active');
    const now = new Date('2027-01-02T00:00:00Z');
    expect(evaluateLicenseAt(active, now)!.to).toBe(evaluateLicenseAt(active, now)!.to);
  });
});

describe('续期与重复请求', () => {
  test('重复续期相同 validTo → 幂等回放；不同 validTo → CONFLICT', () => {
    const renewed = license('Renewed', { validTo: new Date('2028-01-01T00:00:00Z') });
    const replay = renewLicense(renewed, new Date('2028-01-01T00:00:00Z'), ADMIN);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.from).toBe('Renewed');
    expect(replay.to).toBe('Renewed');
    expect('historyEntry' in replay).toBe(false);
    expect('auditEvent' in replay).toBe(false);
    expect('notification' in replay).toBe(false);
    expect(() => renewLicense(renewed, new Date('2029-01-01T00:00:00Z'), ADMIN)).toThrow(/已续期/);
  });

  test('重复续期也必须先校验 actor，DEVICE/SYSTEM 不得取得管理员幂等结果', () => {
    const renewed = license('Renewed', { validTo: new Date('2028-01-01T00:00:00Z') });
    expect(() => renewLicense(renewed, renewed.validTo, DEVICE)).toThrow(/actorType/i);
    expect(() => renewLicense(renewed, renewed.validTo, SYSTEM)).toThrow(/actorType/i);
  });

  test('续期有效时间不晚于当前被拒绝；重复撤销被拒绝（终态）', () => {
    expect(() => renewLicense(license('ExpiringSoon'), T0, ADMIN)).toThrow(/validTo/);
    expect(() => transitionLicense(license('Revoked'), 'Revoked', SUPER_ADMIN, { reason: 'r' })).toThrow(
      LicenseStateError,
    );
  });
});

describe('商业规则：Assignment + License 才允许设备 Active', () => {
  const valid = license('Active');
  test('无 Assignment 激活失败', () => {
    expect(() => assertDeviceRunnable({ hasActiveAssignment: false, license: valid }, T0)).toThrow(DeviceStateError);
  });
  test('无 License / License 失效激活失败', () => {
    expect(() => assertDeviceRunnable({ hasActiveAssignment: true, license: null }, T0)).toThrow(DeviceStateError);
    expect(() => assertDeviceRunnable({ hasActiveAssignment: true, license: license('Expired') }, T0)).toThrow(
      DeviceStateError,
    );
    expect(() => assertDeviceRunnable({ hasActiveAssignment: true, license: license('Revoked') }, T0)).toThrow(
      DeviceStateError,
    );
    // 有效状态但已过有效期
    expect(() =>
      assertDeviceRunnable({ hasActiveAssignment: true, license: valid }, new Date('2027-06-01T00:00:00Z')),
    ).toThrow(DeviceStateError);
  });
  test('已分配且 License 有效 → 通过', () => {
    expect(() => assertDeviceRunnable({ hasActiveAssignment: true, license: valid }, T0)).not.toThrow();
    expect(isLicenseEffective(license('Issued'), T0)).toBe(true);
    expect(isLicenseEffective(license('ExpiringSoon'), T0)).toBe(true);
  });
});
