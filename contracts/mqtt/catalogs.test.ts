/**
 * CT-04 Notification 与 Command 目录测试。
 * 运行：node --test "contracts/mqtt/catalogs.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMAND_CATALOG,
  NOTIFICATION_CATALOG,
  CatalogError,
  getCommand,
  getNotification,
  isCommandAllowed,
  isKnownCommand,
  isKnownNotification,
  commandDenyReason,
  listCommands,
  listNotificationsByAction,
  type CommandCode,
  type CommandCategory,
  type OperationalStatus,
} from './catalogs.ts';

const commandCatalogJson = JSON.parse(readFileSync(new URL('./command-catalog.json', import.meta.url), 'utf8'));
const notificationCatalogJson = JSON.parse(readFileSync(new URL('./notification-catalog.json', import.meta.url), 'utf8'));

const ALL_COMMANDS = Object.keys(COMMAND_CATALOG) as CommandCode[];
const ALL_STATUSES: OperationalStatus[] = ['ACTIVE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED'];

test('22 个 Command 全部唯一且覆盖六大分类', () => {
  assert.equal(ALL_COMMANDS.length, 22);
  assert.equal(new Set(ALL_COMMANDS).size, 22);
  const byCategory = new Map<CommandCategory, number>();
  for (const spec of Object.values(COMMAND_CATALOG)) {
    byCategory.set(spec.category, (byCategory.get(spec.category) ?? 0) + 1);
  }
  assert.deepEqual(
    [...byCategory.keys()].sort(),
    ['DEVICE', 'DISCHARGE', 'HEATING', 'MACHINE', 'MOTOR', 'VENTILATION'].sort()
  );
  assert.deepEqual(Object.fromEntries([...byCategory.entries()].sort()), {
    DEVICE: 5,
    DISCHARGE: 2,
    HEATING: 3,
    MACHINE: 5,
    MOTOR: 3,
    VENTILATION: 4,
  });
});

test('13 个 Notification 全部唯一且有设备动作映射', () => {
  const types = Object.keys(NOTIFICATION_CATALOG);
  assert.equal(types.length, 13);
  assert.equal(new Set(types).size, 13);
  for (const spec of Object.values(NOTIFICATION_CATALOG)) {
    assert.ok(spec.deviceAction.length > 0, `${spec.type} 缺少设备动作`);
  }
  // 六个触发 Sync 的通知 + 安全策略
  assert.deepEqual(
    listNotificationsByAction('SYNC').map((s) => s.type).sort(),
    ['ASSIGNMENT_CHANGED', 'CONFIG_CHANGED', 'LICENSE_CHANGED', 'SECURITY_POLICY_UPDATED', 'STATUS_CHANGED', 'SYNC_REQUIRED', 'USERS_CHANGED'].sort()
  );
  assert.equal(getNotification('CERTIFICATE_ROTATION_REQUIRED').deviceAction, 'ROTATE_CERTIFICATE');
  assert.equal(getNotification('OTA_AVAILABLE').deviceAction, 'AWAIT_OTA_MESSAGE');
  assert.equal(getNotification('DEVICE_RETIRED').deviceAction, 'ENTER_RETIRED_MODE');
});

test('高风险标记与文档一致（EMERGENCY_STOP/FACTORY_RESET/SHUTDOWN/全部加热、排料、电机控制）', () => {
  const highRisk = listCommands({ highRisk: true }).map((s) => s.command).sort();
  assert.deepEqual(highRisk, [
    'AGITATOR_FORWARD', 'AGITATOR_REVERSE', 'AGITATOR_STOP',
    'DISCHARGE_START', 'DISCHARGE_STOP',
    'EMERGENCY_STOP', 'FACTORY_RESET',
    'HEATING_ON', 'HEATING_OFF',
    'SET_TARGET_TEMPERATURE', 'SHUTDOWN',
  ].sort());
});

test('允许状态矩阵无遗漏：22 命令 × 4 状态', () => {
  for (const code of ALL_COMMANDS) {
    for (const status of ALL_STATUSES) {
      const allowed = isCommandAllowed(code, status);
      const spec = getCommand(code);
      if (status === 'RETIRED') {
        assert.equal(allowed, false, `${code} 在 Retired 必须拒绝`);
      } else if (status === 'ACTIVE') {
        assert.equal(allowed, true, `${code} 在 Active 必须允许`);
      } else {
        assert.equal(allowed, spec.allowedStatuses.includes(status), `${code}@${status}`);
      }
    }
  }
});

test('Suspended 仅允许安全停止、诊断、同步和维护/恢复类命令', () => {
  const allowedInSuspended = ALL_COMMANDS.filter((c) => isCommandAllowed(c, 'SUSPENDED')).sort();
  assert.deepEqual(allowedInSuspended, [
    'AGITATOR_STOP', 'AIR_SUPPLY_OFF', 'DISCHARGE_STOP', 'EMERGENCY_STOP', 'EXHAUST_OFF',
    'FORCE_SYNC', 'HEATING_OFF', 'REBOOT', 'SHUTDOWN', 'STOP',
    'TAKE_SNAPSHOT',
  ].sort());
  // 会启动处理的命令必须拒绝
  for (const c of ['START', 'RESUME', 'PAUSE', 'AGITATOR_FORWARD', 'AGITATOR_REVERSE', 'HEATING_ON', 'SET_TARGET_TEMPERATURE', 'EXHAUST_ON', 'AIR_SUPPLY_ON', 'DISCHARGE_START', 'FACTORY_RESET'] as CommandCode[]) {
    assert.equal(isCommandAllowed(c, 'SUSPENDED'), false, `${c} 在 Suspended 必须拒绝`);
  }
});

test('MAINTENANCE 暂按 Suspended 限制（DEC-001）', () => {
  for (const code of ALL_COMMANDS) {
    assert.equal(
      isCommandAllowed(code, 'MAINTENANCE'),
      isCommandAllowed(code, 'SUSPENDED'),
      `${code} 在 Maintenance 应与 Suspended 一致（暂定值）`
    );
  }
});

test('未知命令/通知在运行时被拒绝', () => {
  assert.equal(isKnownCommand('SELF_DESTRUCT'), false);
  assert.equal(isKnownNotification('FIRMWARE_UPDATED'), false);
  assert.throws(() => getCommand('SELF_DESTRUCT'), (e: unknown) => e instanceof CatalogError && (e as CatalogError).kind === 'UNKNOWN_COMMAND');
  assert.throws(() => getNotification('FOO'), (e: unknown) => e instanceof CatalogError && (e as CatalogError).kind === 'UNKNOWN_NOTIFICATION');
  assert.equal(isCommandAllowed('SELF_DESTRUCT', 'ACTIVE'), false);
});

test('denyReason 稳定且允许时返回 null', () => {
  assert.equal(commandDenyReason('START', 'ACTIVE'), null);
  assert.equal(commandDenyReason('START', 'RETIRED'), 'DEVICE_RETIRED');
  assert.equal(commandDenyReason('START', 'SUSPENDED'), 'DEVICE_SUSPENDED_RESTRICTED');
  assert.equal(commandDenyReason('SELF_DESTRUCT', 'ACTIVE'), 'UNKNOWN_COMMAND');
});

test('TS 常量与 command-catalog.json / notification-catalog.json 完全一致', () => {
  assert.equal(commandCatalogJson.commands.length, 22);
  for (const entry of commandCatalogJson.commands) {
    const spec = getCommand(entry.command);
    assert.equal(spec.category, entry.category, entry.command);
    assert.equal(spec.highRisk, entry.highRisk, entry.command);
    assert.deepEqual([...spec.allowedStatuses].sort(), [...entry.allowedStatuses].sort(), entry.command);
  }
  assert.equal(notificationCatalogJson.notifications.length, 13);
  for (const entry of notificationCatalogJson.notifications) {
    const spec = getNotification(entry.type);
    assert.equal(spec.deviceAction, entry.deviceAction, entry.type);
  }
});

test('Schema 枚举与目录一致（cmd/ack command、notification type）', () => {
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const cmdSchema = read('./schemas/cmd.schema.json');
  const ackSchema = read('./schemas/ack.schema.json');
  const ntfSchema = read('./schemas/notification.schema.json');
  assert.deepEqual(cmdSchema.properties.data.properties.command.enum, ALL_COMMANDS);
  assert.deepEqual(ackSchema.properties.data.properties.command.enum, ALL_COMMANDS);
  assert.deepEqual(ntfSchema.properties.data.properties.type.enum.sort(), Object.keys(NOTIFICATION_CATALOG).sort());
});
