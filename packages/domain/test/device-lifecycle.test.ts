/**
 * DOM-01 状态机完整转换测试。
 * 覆盖：文档允许转换全部成功；非法跳转穷举拒绝；执行者/前提/原因校验；
 * 失败时状态与历史不变（纯函数 + 冻结入参）；Retired 不可恢复；无外部 Provisioned 状态。
 */
import { describe, expect, test } from 'vitest';
import {
  DeviceStateError,
  LIFECYCLE_STATUSES,
  LIFECYCLE_TRANSITIONS,
  OPERATIONAL_TRANSITIONS,
  OPERATIONAL_STATUSES,
  transitionLifecycle,
  transitionOperational,
  type Actor,
  type DeviceStateSnapshot,
  type LifecycleStatus,
  type OperationalStatus,
  type TransitionContext,
} from '../src/index.js';

const SUPER_ADMIN: Actor = { actorType: 'ADMIN', actorId: 'admin-1', actorRole: 'PlatformSuperAdmin' };
const OPERATOR: Actor = { actorType: 'ADMIN', actorId: 'op-1', actorRole: 'PlatformOperator' };
const SYSTEM: Actor = { actorType: 'SYSTEM', actorId: 'system' };
const DEVICE: Actor = { actorType: 'DEVICE', actorId: 'dev-x' };

function device(
  lifecycleStatus: LifecycleStatus,
  operationalStatus: OperationalStatus | null = null,
): DeviceStateSnapshot {
  return Object.freeze({ id: 'dev-x', lifecycleStatus, operationalStatus });
}

/** 每条文档迁移对应的合法上下文。 */
const LEGAL: ReadonlyArray<{
  from: LifecycleStatus;
  to: LifecycleStatus;
  actor: Actor;
  ctx: TransitionContext;
}> = [
  { from: 'PendingOnboarding', to: 'OnboardingApproved', actor: SUPER_ADMIN, ctx: { deviceValidated: true } },
  { from: 'PendingOnboarding', to: 'Rejected', actor: SUPER_ADMIN, ctx: { reason: '库存序列号不存在' } },
  {
    from: 'OnboardingApproved',
    to: 'Onboarded',
    actor: SYSTEM,
    ctx: { certificateInstalled: true, firstHeartbeatReceived: true },
  },
  { from: 'Onboarded', to: 'Assigned', actor: SUPER_ADMIN, ctx: { assignment: { customerId: 'c1', siteId: 's1' } } },
  { from: 'Assigned', to: 'Licensed', actor: SYSTEM, ctx: { licenseIssuedAndSynced: true } },
  { from: 'Licensed', to: 'Active', actor: DEVICE, ctx: { licenseVerifiedByDevice: true } },
  { from: 'Active', to: 'Suspended', actor: OPERATOR, ctx: { reason: '安全调查' } },
  { from: 'Suspended', to: 'Active', actor: SUPER_ADMIN, ctx: { issueResolvedApproved: true, reason: '问题已解决' } },
  { from: 'Active', to: 'Retired', actor: SUPER_ADMIN, ctx: { reason: '合约终止' } },
  { from: 'Suspended', to: 'Retired', actor: SUPER_ADMIN, ctx: { reason: '永久退役' } },
];

describe('文档允许转换全部成功', () => {
  for (const { from, to, actor, ctx } of LEGAL) {
    test(`${from} → ${to}`, () => {
      const operational = from === 'Active' ? 'Active' : from === 'Suspended' ? 'Suspended' : null;
      const effects = transitionLifecycle(device(from, operational), to, actor, ctx);
      expect(effects.lifecycle).toEqual({ from, to });
      // 所有迁移生成 state_history 与审计事件
      expect(effects.stateHistory.length).toBeGreaterThanOrEqual(1);
      expect(effects.stateHistory[0]).toMatchObject({ axis: 'lifecycle', fromStatus: from, toStatus: to });
      expect(effects.auditEvent).toMatchObject({ objectType: 'device', objectId: 'dev-x' });
      expect(effects.auditEvent.action).toBe(`device.lifecycle.${from}_to_${to}`);
    });
  }

  test('Licensed → Active 镜像派生 operational=Active；Active → Suspended/Retired 同步镜像', () => {
    const activated = transitionLifecycle(device('Licensed', null), 'Active', DEVICE, {
      licenseVerifiedByDevice: true,
    });
    expect(activated.operational).toEqual({ from: null, to: 'Active' });
    expect(activated.stateHistory.some((h) => h.axis === 'operational' && h.toStatus === 'Active')).toBe(true);

    const suspended = transitionLifecycle(device('Active', 'Active'), 'Suspended', OPERATOR, { reason: 'r' });
    expect(suspended.operational).toEqual({ from: 'Active', to: 'Suspended' });
    expect(suspended.stateHistory).toHaveLength(2);
  });

  test('OnboardingApproved → Onboarded 标记内部 PROVISIONING 步骤', () => {
    const effects = transitionLifecycle(device('OnboardingApproved'), 'Onboarded', SYSTEM, {
      certificateInstalled: true,
      firstHeartbeatReceived: true,
    });
    expect(effects.internalSteps).toEqual(['PROVISIONING']);
  });
});

describe('Operational 轴（Active ↔ Maintenance）', () => {
  test('Active → Maintenance → Active 均成功且记录独立 state_history', () => {
    const active = device('Active', 'Active');
    const toMaintenance = transitionOperational(active, 'Maintenance', OPERATOR, { reason: '计划维护' });
    expect(toMaintenance.operational).toEqual({ from: 'Active', to: 'Maintenance' });
    expect(toMaintenance.lifecycle).toBeNull();
    expect(toMaintenance.stateHistory[0]).toMatchObject({
      axis: 'operational',
      fromStatus: 'Active',
      toStatus: 'Maintenance',
    });
    expect(toMaintenance.auditEvent.action).toBe('device.operational.Active_to_Maintenance');

    const back = transitionOperational(device('Active', 'Maintenance'), 'Active', SUPER_ADMIN, { reason: '维护完成' });
    expect(back.operational).toEqual({ from: 'Maintenance', to: 'Active' });
  });

  test('Maintenance 不是 Suspended 的别名：状态名独立记录', () => {
    const effects = transitionOperational(device('Active', 'Active'), 'Maintenance', SUPER_ADMIN, { reason: 'r' });
    expect(effects.stateHistory[0]!.toStatus).toBe('Maintenance');
    expect(effects.stateHistory[0]!.toStatus).not.toBe('Suspended');
  });

  test('Suspended/Retired 的 Operational 无主动迁移（由生命周期镜像）', () => {
    expect(OPERATIONAL_TRANSITIONS.Suspended).toEqual([]);
    expect(OPERATIONAL_TRANSITIONS.Retired).toEqual([]);
    expect(() =>
      transitionOperational(device('Suspended', 'Suspended'), 'Active', SUPER_ADMIN, { reason: 'r' }),
    ).toThrow(DeviceStateError);
  });

  test('Operational 迁移必须填写原因', () => {
    expect(() => transitionOperational(device('Active', 'Active'), 'Maintenance', OPERATOR, {})).toThrow(
      DeviceStateError,
    );
  });
});

describe('非法跳转穷举：所有未列出的生命周期迁移全部失败', () => {
  const allowed = new Set(
    Object.entries(LIFECYCLE_TRANSITIONS).flatMap(([from, rules]) => rules.map((r) => `${from}->${r.to}`)),
  );
  const FULL_CTX: TransitionContext = {
    deviceValidated: true,
    certificateInstalled: true,
    firstHeartbeatReceived: true,
    assignment: { customerId: 'c1', siteId: 's1' },
    licenseIssuedAndSynced: true,
    licenseVerifiedByDevice: true,
    issueResolvedApproved: true,
    reason: '测试原因',
  };
  for (const from of LIFECYCLE_STATUSES) {
    for (const to of LIFECYCLE_STATUSES) {
      if (allowed.has(`${from}->${to}`)) continue;
      test(`${from} → ${to} 被拒绝`, () => {
        expect(() => transitionLifecycle(device(from), to, SUPER_ADMIN, FULL_CTX)).toThrow(DeviceStateError);
      });
    }
  }
});

describe('执行者与前置条件', () => {
  test('审批/分配/退役必须由 PlatformSuperAdmin 执行', () => {
    expect(() =>
      transitionLifecycle(device('PendingOnboarding'), 'OnboardingApproved', OPERATOR, { deviceValidated: true }),
    ).toThrow(DeviceStateError);
    expect(() =>
      transitionLifecycle(device('Onboarded'), 'Assigned', OPERATOR, {
        assignment: { customerId: 'c1', siteId: 's1' },
      }),
    ).toThrow(DeviceStateError);
    expect(() => transitionLifecycle(device('Active', 'Active'), 'Retired', OPERATOR, { reason: 'r' })).toThrow(
      DeviceStateError,
    );
  });

  test('DEVICE/SYSTEM 不能执行管理迁移', () => {
    expect(() => transitionLifecycle(device('Active', 'Active'), 'Suspended', DEVICE, { reason: 'r' })).toThrow(
      DeviceStateError,
    );
    expect(() => transitionLifecycle(device('Active', 'Active'), 'Suspended', SYSTEM, { reason: 'r' })).toThrow(
      DeviceStateError,
    );
  });

  test('前置条件缺失分别被拒绝', () => {
    expect(() => transitionLifecycle(device('PendingOnboarding'), 'OnboardingApproved', SUPER_ADMIN, {})).toThrow(
      /deviceValidated/,
    );
    expect(() =>
      transitionLifecycle(device('OnboardingApproved'), 'Onboarded', SYSTEM, { certificateInstalled: true }),
    ).toThrow(/firstHeartbeatReceived/);
    expect(() => transitionLifecycle(device('Onboarded'), 'Assigned', SUPER_ADMIN, {})).toThrow(/assignment/);
    expect(() => transitionLifecycle(device('Assigned'), 'Licensed', SYSTEM, {})).toThrow(/licenseIssuedAndSynced/);
    expect(() => transitionLifecycle(device('Licensed'), 'Active', DEVICE, {})).toThrow(/licenseVerifiedByDevice/);
    expect(() => transitionLifecycle(device('Suspended', 'Suspended'), 'Active', SUPER_ADMIN, { reason: 'r' })).toThrow(
      /issueResolvedApproved/,
    );
  });

  test('拒绝/挂起/恢复/退役必须填写原因', () => {
    expect(() => transitionLifecycle(device('PendingOnboarding'), 'Rejected', SUPER_ADMIN, {})).toThrow(/原因/);
    expect(() => transitionLifecycle(device('Active', 'Active'), 'Suspended', OPERATOR, { reason: '  ' })).toThrow(
      /原因/,
    );
    expect(() =>
      transitionLifecycle(device('Suspended', 'Suspended'), 'Active', SUPER_ADMIN, { issueResolvedApproved: true }),
    ).toThrow(/原因/);
  });
});

describe('终态与协议约束', () => {
  test('Retired 不可恢复：任何转出失败', () => {
    for (const to of LIFECYCLE_STATUSES) {
      expect(() => transitionLifecycle(device('Retired', 'Retired'), to, SUPER_ADMIN, { reason: 'r' })).toThrow(
        DeviceStateError,
      );
    }
  });

  test('Rejected 为终态（重新入网走新 Onboarding 申请，不经状态机复活）', () => {
    expect(LIFECYCLE_TRANSITIONS.Rejected).toEqual([]);
  });

  test('不存在外部 Provisioned 状态（Provisioning 仅为内部步骤）', () => {
    expect(LIFECYCLE_STATUSES).not.toContain('Provisioned');
    expect(LIFECYCLE_STATUSES).toHaveLength(9);
    expect(OPERATIONAL_STATUSES).toEqual(['Active', 'Maintenance', 'Suspended', 'Retired']);
  });
});

describe('失败纯度：状态与历史不变化', () => {
  test('非法迁移抛错且不返回 effects、不修改入参（冻结对象）', () => {
    const frozen = device('Active', 'Active');
    let effects: unknown = null;
    try {
      effects = transitionLifecycle(frozen, 'Retired', OPERATOR, { reason: 'r' }); // 角色不足
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceStateError);
    }
    expect(effects).toBeNull();
    expect(frozen.lifecycleStatus).toBe('Active');
    expect(frozen.operationalStatus).toBe('Active');
  });

  test('缺前提的失败同样不产生 effects', () => {
    let effects: unknown = null;
    try {
      effects = transitionLifecycle(device('Assigned'), 'Licensed', SYSTEM, {});
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceStateError);
    }
    expect(effects).toBeNull();
  });
});
