/**
 * BE-IOT-02 Payload Schema 校验与时钟偏差校验。
 *
 * - Schema：CT-03 零依赖校验器（contracts/mqtt/validator.mjs），按 iotType 选择 <type>.schema.json；
 *   首个错误路径写入 Quarantine 记录；字段范围（minimum/maximum/enum）由 Schema 覆盖；
 * - 时钟偏差：meta.ts（设备自报时间）与 iotReceivedAt（broker 时间）偏差超阈值 → 不可重试隔离。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { quarantineError } from './errors.js';
import type { IngressEnvelope } from './envelope.js';

// @ts-expect-error CT-03 零依赖校验器为 .mjs（无类型声明），接口见 contracts/mqtt/validator.mjs
import { SchemaRegistry, validate as validateAgainstSchema } from '@fdp/contracts/mqtt/validator.mjs';

interface ContractsValidator {
  SchemaRegistry: new (dir: string) => { load(fileName: string): { doc: unknown } };
  validate(
    schema: unknown,
    fileName: string,
    payload: unknown,
    registry: unknown,
  ): { path: string; keyword: string; message: string }[];
}

const contractsValidator = { SchemaRegistry, validate: validateAgainstSchema } as unknown as ContractsValidator;

/** 解析 contracts 包的 schemas 目录（monorepo 源码直引；打包部署时需随包携带）。 */
function defaultSchemasDir(): string {
  if (process.env.MQTT_SCHEMAS_DIR) return process.env.MQTT_SCHEMAS_DIR;
  const require = createRequire(import.meta.url);
  const validatorPath = require.resolve('@fdp/contracts/mqtt/validator.mjs');
  return join(dirname(validatorPath), 'schemas');
}

export interface SchemaValidator {
  validatePayload(envelope: IngressEnvelope): void;
}

export function createSchemaValidator(schemasDir: string = defaultSchemasDir()): SchemaValidator {
  const registry = new contractsValidator.SchemaRegistry(schemasDir);
  return {
    validatePayload(envelope) {
      const fileName = `${envelope.iotType}.schema.json`;
      let schema: unknown;
      try {
        schema = registry.load(fileName).doc;
      } catch {
        // 上行类型已由 Envelope 白名单收敛，理论不可达；防御性隔离而非重试
        throw quarantineError('SCHEMA_VIOLATION', '(root)', `schema not found for type ${envelope.iotType}`);
      }
      const errors = contractsValidator.validate(schema, fileName, envelope.payload, registry);
      if (errors.length > 0) {
        const first = errors[0];
        throw quarantineError(
          'SCHEMA_VIOLATION',
          first?.path ?? '(root)',
          `payload violates ${fileName}: ${first?.message ?? 'invalid'}`,
        );
      }
    },
  };
}

/** 时钟偏差校验：meta.ts 存在时与 broker 接收时间比对。 */
export function assertClockSkew(envelope: IngressEnvelope, toleranceSeconds: number): void {
  const meta = envelope.payload.meta;
  if (typeof meta !== 'object' || meta === null) return; // meta 缺失由 Schema 校验判定
  const ts = (meta as Record<string, unknown>).ts;
  if (typeof ts !== 'string') return;
  const deviceTs = Date.parse(ts);
  if (Number.isNaN(deviceTs)) return; // 格式错误由 Schema 校验判定
  const skewSeconds = Math.abs(deviceTs - envelope.iotReceivedAt) / 1000;
  if (skewSeconds > toleranceSeconds) {
    throw quarantineError(
      'CLOCK_SKEW',
      'meta.ts',
      `device clock skew ${Math.round(skewSeconds)}s exceeds tolerance ${toleranceSeconds}s`,
    );
  }
}
