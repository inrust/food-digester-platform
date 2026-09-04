/**
 * DEC-009 摄像头交互语义策略测试。
 * 运行：node --test "contracts/domain/camera-interaction-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  CAMERA_INTERACTION_POLICY,
  getCameraPolicyStatus,
  getCameraRefreshMode,
  getCameraViewingScope,
  isCameraAutoRefreshAllowed,
  isLiveStreamingEnabled,
} from './camera-interaction-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./camera-interaction-policy.json');
const policySchema = read('./camera-interaction-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'camera-interaction-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：实时流启用、非法范围/刷新模式与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'camera-interaction-policy.schema.json', m, registry);
  };
  // 实时流启用被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.liveStreaming as Record<string, unknown>).enabled = true;
    }).some((e) => e.path === 'liveStreaming.enabled' && e.keyword === 'enum'),
  );
  // 非法查看范围被拒绝
  assert.ok(
    run((m) => {
      (m.viewing as Record<string, unknown>).scope = 'everything';
    }).some((e) => e.path === 'viewing.scope' && e.keyword === 'enum'),
  );
  // 非法刷新模式被拒绝
  assert.ok(
    run((m) => {
      (m.refresh as Record<string, unknown>).mode = 'websocket';
    }).some((e) => e.path === 'refresh.mode' && e.keyword === 'enum'),
  );
  // 缺字段与额外字段被拒绝
  assert.ok(
    run((m) => {
      delete m.liveStreaming;
    }).some((e) => e.keyword === 'required'),
  );
  assert.ok(
    run((m) => {
      m.extra = 1;
    }).some((e) => e.keyword === 'additionalProperties'),
  );
});

test('x-decision-versions 引用 DEC-009 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec009 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-009');
  assert.ok(dec009, '决策登记必须包含 DEC-009');
  assert.ok(refs.includes(`DEC-009@${dec009.version}`), `引用必须包含 DEC-009@${dec009.version}`);
  assert.ok(
    traceabilityYaml.includes(`DEC-009@${dec009.version}`),
    'prototype-traceability.yaml 必须引用 DEC-009 当前登记版本',
  );
  if (dec009.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('冻结值定性规则可执行：仅最新授权 Media、手动刷新、禁实时流', () => {
  assert.equal(getCameraViewingScope(), 'latest-authorized-media-only');
  assert.equal(getCameraRefreshMode(), 'manual-only');
  assert.equal(isCameraAutoRefreshAllowed(), false);
  assert.equal(isLiveStreamingEnabled(), false);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-009 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [
    CAMERA_INTERACTION_POLICY.viewing,
    CAMERA_INTERACTION_POLICY.refresh,
    CAMERA_INTERACTION_POLICY.liveStreaming,
  ]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec009 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-009');
  for (const task of dec009.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 camera-interaction-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, CAMERA_INTERACTION_POLICY.policyVersion);
  assert.equal(policyJson.status, CAMERA_INTERACTION_POLICY.status);
  assert.equal(policyJson.viewing.scope, CAMERA_INTERACTION_POLICY.viewing.scope);
  assert.equal(policyJson.viewing.note, CAMERA_INTERACTION_POLICY.viewing.note);
  assert.deepEqual(policyJson.viewing.consumers, [...CAMERA_INTERACTION_POLICY.viewing.consumers]);
  assert.equal(policyJson.refresh.mode, CAMERA_INTERACTION_POLICY.refresh.mode);
  assert.equal(policyJson.refresh.note, CAMERA_INTERACTION_POLICY.refresh.note);
  assert.deepEqual(policyJson.refresh.consumers, [...CAMERA_INTERACTION_POLICY.refresh.consumers]);
  assert.equal(policyJson.liveStreaming.enabled, CAMERA_INTERACTION_POLICY.liveStreaming.enabled);
  assert.equal(policyJson.liveStreaming.note, CAMERA_INTERACTION_POLICY.liveStreaming.note);
  assert.deepEqual(policyJson.liveStreaming.consumers, [...CAMERA_INTERACTION_POLICY.liveStreaming.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...CAMERA_INTERACTION_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, CAMERA_INTERACTION_POLICY.frozenUpgradePath);
  assert.equal(getCameraPolicyStatus(), 'frozen');
});
