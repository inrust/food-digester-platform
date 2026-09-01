/**
 * BE-CMD-01 命令领域规则单测：22 命令矩阵（目录一致性）、状态门、参数/timeoutSec、高风险确认凭证。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, describe, test } from 'vitest';
import {
  COMMAND_CATALOG,
  COMMAND_CATALOG_VERSION,
  COMMAND_CONFIRMATION_TTL_MS,
  COMMAND_TIMEOUT_MAX_SEC,
  CommandError,
  assertCommandAllowed,
  assertCommandParams,
  assertHighRiskConfirmation,
  assertKnownCommand,
  getCommandSpec,
  resolveCommandGateStatus,
} from '../src/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CommandError, 'should throw CommandError');
    return err.code;
  }
  assert.fail('should throw CommandError');
}

describe('命令目录与 CT-04 一致性', () => {
  const catalog = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../contracts/mqtt/command-catalog.json', import.meta.url)), 'utf8'),
  ) as {
    catalogVersion: string;
    commands: { command: string; category: string; highRisk: boolean; allowedStatuses: string[] }[];
  };

  test('22 个命令、catalogVersion、逐字段一致（category/highRisk/allowedStatuses）', () => {
    assert.equal(catalog.commands.length, 22);
    assert.equal(COMMAND_CATALOG.length, 22);
    assert.equal(COMMAND_CATALOG_VERSION, catalog.catalogVersion);
    for (const entry of catalog.commands) {
      const spec = getCommandSpec(entry.command);
      assert.ok(spec, `领域层缺少命令 ${entry.command}`);
      assert.equal(spec.category, entry.category);
      assert.equal(spec.highRisk, entry.highRisk);
      assert.deepEqual([...spec.allowedStatuses], entry.allowedStatuses, `${entry.command} allowedStatuses 不一致`);
    }
  });

  test('未知命令 → VALIDATION_FAILED', () => {
    assert.equal(
      codeOf(() => assertKnownCommand('SELF_DESTRUCT')),
      'VALIDATION_FAILED',
    );
    assert.equal(assertKnownCommand('START').command, 'START');
  });
});

describe('设备状态门（Suspended/Retired 限制）', () => {
  test('门控状态解析：云端权威优先', () => {
    assert.equal(resolveCommandGateStatus('Retired', 'Active'), 'RETIRED');
    assert.equal(resolveCommandGateStatus('Suspended', 'Active'), 'SUSPENDED');
    assert.equal(resolveCommandGateStatus('Active', 'Maintenance'), 'MAINTENANCE');
    assert.equal(resolveCommandGateStatus('Active', 'Suspended'), 'SUSPENDED');
    assert.equal(resolveCommandGateStatus('Active', 'Active'), 'ACTIVE');
    assert.equal(resolveCommandGateStatus('Active', null), 'ACTIVE');
  });

  test('ACTIVE 放行全部 22 命令；RETIRED 拒绝全部', () => {
    for (const spec of COMMAND_CATALOG) {
      assertCommandAllowed(spec, 'ACTIVE');
      assert.equal(
        codeOf(() => assertCommandAllowed(spec, 'RETIRED')),
        'DEVICE_STATE_NOT_ALLOWED',
      );
    }
  });

  test('SUSPENDED/MAINTENANCE：仅 allowedStatuses 子集放行（启动处理类拒绝）', () => {
    for (const spec of COMMAND_CATALOG) {
      for (const gate of ['SUSPENDED', 'MAINTENANCE'] as const) {
        if (spec.allowedStatuses.includes(gate)) {
          assertCommandAllowed(spec, gate);
        } else {
          assert.equal(
            codeOf(() => assertCommandAllowed(spec, gate)),
            'DEVICE_STATE_NOT_ALLOWED',
          );
        }
      }
    }
    // 抽样语义断言：START/RESUME/HEATING_ON/AGITATOR_FORWARD/DISCHARGE_START 在 Suspended 下必须拒绝
    for (const cmd of ['START', 'RESUME', 'HEATING_ON', 'AGITATOR_FORWARD', 'DISCHARGE_START']) {
      assert.equal(
        codeOf(() => assertCommandAllowed(assertKnownCommand(cmd), 'SUSPENDED')),
        'DEVICE_STATE_NOT_ALLOWED',
      );
    }
    // 安全停止/诊断/同步类在 Suspended 下允许
    for (const cmd of ['STOP', 'EMERGENCY_STOP', 'AGITATOR_STOP', 'HEATING_OFF', 'DISCHARGE_STOP', 'FORCE_SYNC']) {
      assertCommandAllowed(assertKnownCommand(cmd), 'SUSPENDED');
    }
  });
});

describe('参数与 timeoutSec 校验', () => {
  test('timeoutSec 边界（1~3600 暂定上限）；非整数/越界 → VALIDATION_FAILED', () => {
    assert.equal(assertCommandParams('START', 60, undefined), 60);
    assert.equal(assertCommandParams('START', COMMAND_TIMEOUT_MAX_SEC, undefined), COMMAND_TIMEOUT_MAX_SEC);
    assert.equal(
      codeOf(() => assertCommandParams('START', 0, undefined)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertCommandParams('START', 3601, undefined)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertCommandParams('START', 1.5, undefined)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertCommandParams('START', '60', undefined)),
      'VALIDATION_FAILED',
    );
  });

  test('remarks 超长 → VALIDATION_FAILED', () => {
    assert.equal(
      codeOf(() => assertCommandParams('START', 60, 'x'.repeat(501))),
      'VALIDATION_FAILED',
    );
    assertCommandParams('START', 60, '正常备注');
  });
});

describe('高风险确认凭证', () => {
  const NOW = new Date('2026-08-30T12:00:00Z');
  const highRisk = assertKnownCommand('EMERGENCY_STOP');
  const lowRisk = assertKnownCommand('START');

  test('非高风险不要求确认', () => {
    assertHighRiskConfirmation(lowRisk, undefined, NOW);
  });

  test('高风险缺确认 / confirmText 不符 / 时间非法 → VALIDATION_FAILED', () => {
    assert.equal(
      codeOf(() => assertHighRiskConfirmation(highRisk, undefined, NOW)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertHighRiskConfirmation(highRisk, { confirmText: 'STOP', confirmedAt: NOW.toISOString() }, NOW)),
      'VALIDATION_FAILED',
    );
    assert.equal(
      codeOf(() => assertHighRiskConfirmation(highRisk, { confirmText: 'EMERGENCY_STOP', confirmedAt: 'bad' }, NOW)),
      'VALIDATION_FAILED',
    );
  });

  test('过期确认与未来确认 → VALIDATION_FAILED；TTL 内放行', () => {
    const stale = new Date(NOW.getTime() - COMMAND_CONFIRMATION_TTL_MS - 1000).toISOString();
    assert.equal(
      codeOf(() => assertHighRiskConfirmation(highRisk, { confirmText: 'EMERGENCY_STOP', confirmedAt: stale }, NOW)),
      'VALIDATION_FAILED',
    );
    const future = new Date(NOW.getTime() + 120_000).toISOString();
    assert.equal(
      codeOf(() => assertHighRiskConfirmation(highRisk, { confirmText: 'EMERGENCY_STOP', confirmedAt: future }, NOW)),
      'VALIDATION_FAILED',
    );
    assertHighRiskConfirmation(
      highRisk,
      { confirmText: 'EMERGENCY_STOP', confirmedAt: new Date(NOW.getTime() - 1000).toISOString() },
      NOW,
    );
  });
});
