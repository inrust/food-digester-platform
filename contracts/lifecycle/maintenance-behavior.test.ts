/**
 * DEC-001 Maintenance 行为矩阵测试。
 * 运行：node --test "contracts/lifecycle/maintenance-behavior.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MAINTENANCE_BEHAVIOR_MATRIX,
  MaintenanceMatrixError,
  getMaintenanceBehavior,
  getMaintenanceSyncIntervalSeconds,
  isKnownMaintenanceBehavior,
  isMaintenanceBehaviorAllowed,
  isMaintenanceCommandAllowed,
  maintenanceCommandDenyReason,
  type MaintenanceBehavior,
} from './maintenance-behavior.ts';
import { COMMAND_CATALOG, isCommandAllowed, type CommandCode } from '../mqtt/catalogs.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const matrixJson = read('./maintenance-behavior-matrix.json');
const schemaJson = read('./maintenance-behavior-matrix.schema.json');
const registerJson = read('../decisions/decision-register.json');

const ALL_BEHAVIORS = Object.keys(MAINTENANCE_BEHAVIOR_MATRIX.behaviors) as MaintenanceBehavior[];
const ALL_COMMANDS = Object.keys(COMMAND_CATALOG) as CommandCode[];
const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('矩阵 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(schemaJson, 'maintenance-behavior-matrix.schema.json', matrixJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：缺失必填字段、非法枚举与额外行为键被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(matrixJson));
    mutate(m);
    return validate(schemaJson, 'maintenance-behavior-matrix.schema.json', m, registry);
  };
  // 缺少必填字段
  assert.ok(
    run((m) => {
      delete m.matrixVersion;
    }).some((e) => e.keyword === 'required'),
  );
  // status 非法枚举
  assert.ok(
    run((m) => {
      m.status = 'draft';
    }).some((e) => e.path === 'status' && e.keyword === 'enum'),
  );
  // fallbackPolicy 必须为 deny（失败关闭）
  assert.ok(
    run((m) => {
      m.fallbackPolicy = 'allow';
    }).some((e) => e.path === 'fallbackPolicy' && e.keyword === 'enum'),
  );
  // 额外行为键被拒绝（封闭键集合）
  assert.ok(
    run((m) => {
      (m.behaviors as Record<string, unknown>).REALTIME_VIDEO = { allowed: true, consumers: ['FE-14'], note: 'x' };
    }).some((e) => e.keyword === 'additionalProperties'),
  );
  // 行为缺少 note
  assert.ok(
    run((m) => {
      delete (m.behaviors as Record<string, Record<string, unknown>>).OTA.note;
    }).some((e) => e.path.startsWith('behaviors.OTA') && e.keyword === 'required'),
  );
});

test('x-decision-versions 引用 DEC-001 且版本与决策登记一致', () => {
  const refs: string[] = matrixJson['x-decision-versions'];
  const dec001 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-001');
  assert.ok(dec001, '决策登记必须包含 DEC-001');
  assert.ok(refs.includes(`DEC-001@${dec001.version}`), `引用必须包含 DEC-001@${dec001.version}`);
  // 兼容性守卫：若未来登记被回退为未冻结状态，矩阵必须同步回退为 provisional 0.x。
  if (dec001.status !== 'frozen') {
    assert.equal(matrixJson.status, 'provisional');
    assert.ok(matrixJson.matrixVersion.startsWith('0.'));
  }
});

test('冻结值：独立状态；允许维护、同步、遥测、告警和 OTA', () => {
  assert.equal(matrixJson.subject.operationalStatus, 'MAINTENANCE');
  assert.equal(matrixJson.subject.independentState, true);
  for (const b of [
    'SYNC',
    'MAINTENANCE_COMMANDS',
    'TELEMETRY_INGESTION',
    'ALARM_EVENT_TAMPER_PROCESSING',
    'OTA',
    'RETIREMENT',
  ] as const) {
    assert.equal(isMaintenanceBehaviorAllowed(b), true, `${b} 必须允许`);
  }
  // 启动处理类命令在 Maintenance 拒绝（与 Suspended 一致）
  assert.equal(isMaintenanceBehaviorAllowed('PROCESSING_COMMANDS'), false);
});

test('Maintenance Sync 节奏为 15 分钟（Suspended 节奏）', () => {
  assert.equal(getMaintenanceSyncIntervalSeconds(), 900);
});

test('失败关闭：未知行为拒绝并抛出稳定错误', () => {
  assert.equal(isMaintenanceBehaviorAllowed('REALTIME_VIDEO'), false);
  assert.equal(isMaintenanceBehaviorAllowed('REMOTE_RESTART'), false);
  assert.equal(isKnownMaintenanceBehavior('OTA'), true);
  assert.throws(
    () => getMaintenanceBehavior('REALTIME_VIDEO'),
    (e: unknown) => e instanceof MaintenanceMatrixError && (e as MaintenanceMatrixError).kind === 'UNKNOWN_BEHAVIOR',
  );
});

test('命令策略与 command-catalog 一致：Maintenance 允许集合 == Suspended 允许集合', () => {
  assert.equal(MAINTENANCE_BEHAVIOR_MATRIX.commandPolicy.mode, 'same-as-suspended');
  for (const code of ALL_COMMANDS) {
    assert.equal(
      isMaintenanceCommandAllowed(code),
      isCommandAllowed(code, 'SUSPENDED'),
      `${code} 在 Maintenance 应与 Suspended 一致（冻结值）`,
    );
  }
  // 维护/停止/同步类允许
  for (const c of ['STOP', 'EMERGENCY_STOP', 'FORCE_SYNC', 'TAKE_SNAPSHOT', 'REBOOT'] as CommandCode[]) {
    assert.equal(isMaintenanceCommandAllowed(c), true, `${c} 必须允许`);
  }
  // 启动处理类拒绝
  for (const c of [
    'START',
    'RESUME',
    'AGITATOR_FORWARD',
    'HEATING_ON',
    'DISCHARGE_START',
    'FACTORY_RESET',
  ] as CommandCode[]) {
    assert.equal(isMaintenanceCommandAllowed(c), false, `${c} 必须拒绝`);
  }
  // 未知命令失败关闭
  assert.equal(isMaintenanceCommandAllowed('SELF_DESTRUCT'), false);
  // denyReason 稳定
  assert.equal(maintenanceCommandDenyReason('STOP'), null);
  assert.equal(maintenanceCommandDenyReason('START'), 'DEVICE_MAINTENANCE_RESTRICTED');
  assert.equal(maintenanceCommandDenyReason('SELF_DESTRUCT'), 'UNKNOWN_COMMAND');
});

test('行为条目消费者均为合法任务 ID 且覆盖 DEC-001 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const b of ALL_BEHAVIORS) {
    const spec = getMaintenanceBehavior(b);
    assert.ok(spec.note.length > 0, `${b} 缺少 note`);
    assert.ok(spec.consumers.length > 0, `${b} 缺少 consumers`);
    for (const c of spec.consumers) {
      assert.ok(TASK_ID.test(c), `${b} 的消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  // DEC-001 的全部阻塞任务均有至少一个行为条目承接
  for (const task of registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-001').blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被任何行为条目承接`);
  }
});

test('TS 常量与 maintenance-behavior-matrix.json 完全一致', () => {
  assert.equal(matrixJson.matrixVersion, MAINTENANCE_BEHAVIOR_MATRIX.matrixVersion);
  assert.equal(matrixJson.status, MAINTENANCE_BEHAVIOR_MATRIX.status);
  assert.equal(matrixJson.fallbackPolicy, MAINTENANCE_BEHAVIOR_MATRIX.fallbackPolicy);
  assert.equal(matrixJson.commandPolicy.mode, MAINTENANCE_BEHAVIOR_MATRIX.commandPolicy.mode);
  assert.equal(matrixJson.commandPolicy.reference, MAINTENANCE_BEHAVIOR_MATRIX.commandPolicy.reference);
  assert.deepEqual(Object.keys(matrixJson.behaviors).sort(), [...ALL_BEHAVIORS].sort());
  for (const b of ALL_BEHAVIORS) {
    const json = matrixJson.behaviors[b];
    const spec = MAINTENANCE_BEHAVIOR_MATRIX.behaviors[b];
    assert.equal(spec.allowed, json.allowed, b);
    assert.equal(spec.syncIntervalSeconds, json.syncIntervalSeconds, b);
    assert.deepEqual([...spec.consumers].sort(), [...json.consumers].sort(), b);
    assert.equal(spec.note, json.note, b);
  }
});
