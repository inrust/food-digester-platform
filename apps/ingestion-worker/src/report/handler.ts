/**
 * BE-IOT-06 ESG Report Handler：Cycle/Hourly/Daily 报告保存 + 归档 outbox。
 *
 * 处理链（输入为 BE-IOT-02 已校验消息；audit.hash 必填由 CT-03 Schema 把关）：
 * 1. 期间语义校验（Schema 之外的领域约束）：
 *    - periodEndTime < periodStartTime → QUARANTINE/INVALID_REPORT；
 *    - 同设备同类型期间重叠（不同起点且区间相交）→ QUARANTINE/INVALID_REPORT；
 * 2. BE-IOT-03 receipt 幂等；相同报告（同期间起点重放，可携带新 seq）→ duplicate 跳过；
 * 3. 业务写入（同事务）：esg_reports 行 + 恰好一个 ARCHIVE outbox
 *    （归档字段与 RDS 列完整一致，另附 payloadHash/audit.hash/原始 Payload）；
 * 4. 技术对接：保留 audit.hash（归档载荷）与计算方法版本（carbonReductionMethod 列）；
 *    不宣称第三方核证（归档载荷 attestation=NONE）。
 *
 * 功能边界：不重新定义设备端报告算法（calculationVersionId 解析归 ESG 领域任务）。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from '../ingest/errors.js';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { buildReportRow, findOverlappingReport, insertReport, REPORT_TYPES } from './repository.js';
import type { ReportType, ReportWrite } from './repository.js';

export interface ReportHandlerDeps {
  readonly client: DbClient;
}

export interface ReportHandleResult {
  /** false 表示非 report 类型消息（分发器不应路由到此）。 */
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  /** created=新报告入库；duplicate=相同报告幂等跳过。 */
  readonly reportStatus: 'created' | 'duplicate' | undefined;
  /** 本次是否写入归档 outbox 事件。 */
  readonly archived: boolean;
}

const NOT_HANDLED: ReportHandleResult = {
  handled: false,
  outcome: undefined,
  reportStatus: undefined,
  archived: false,
};

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export function createReportHandler(
  deps: ReportHandlerDeps,
): (message: ValidatedMessage) => Promise<ReportHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'report') return NOT_HANDLED;

    const data = message.data;
    const reportType = asString(data.reportType) as ReportType | undefined;
    const periodStart = asString(data.periodStartTime);
    const periodEnd = asString(data.periodEndTime);
    if (!reportType || !REPORT_TYPES.includes(reportType) || !periodStart || !periodEnd) {
      throw quarantineError('INVALID_REPORT', 'data.reportType', 'report missing or invalid reportType/period fields');
    }
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (end.getTime() < start.getTime()) {
      throw quarantineError('INVALID_REPORT', 'data.periodEndTime', 'period end is earlier than period start');
    }

    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.normalizedPayload);

    const baseWrite = {
      deviceId,
      reportType,
      periodStartTime: start,
      periodEndTime: end,
      sourceMessageId: message.messageId,
      feedingWeightKg: asNumber(data.feedingWeightKg),
      dischargeWeightKg: asNumber(data.dischargeWeightKg),
      reductionWeightKg: asNumber(data.reductionWeightKg),
      cycleCount: asNumber(data.cycleCount),
      processingDurationMinutes: asNumber(data.processingDurationMinutes),
      energyConsumptionKwh: asNumber(data.energyConsumptionKwh),
      averagePowerKw: asNumber(data.averagePowerKw),
      averageO2Pct: asNumber(data.averageO2Pct),
      averageCo2Ppm: asNumber(data.averageCo2Ppm),
      averageCh4Ppm: asNumber(data.averageCh4Ppm),
      averageN2oPpm: asNumber(data.averageN2oPpm),
      carbonReductionKg: asNumber(data.carbonReductionKg),
      carbonReductionMethod: asString(data.carbonReductionMethod),
      dataCompletenessPct: asNumber(data.dataCompletenessPct),
      missingRecordCount: asNumber(data.missingRecordCount),
    };

    const processed = await processWithReceipt<{ readonly status: 'created' | 'duplicate' }>(deps.client, {
      key: { deviceId, topicType: 'report', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      occurredAt: new Date(message.occurredAt),
      customerId: message.device.customerId,
      siteId: message.device.siteId ?? null,
      business: async (tx, attribution) => {
        if (!attribution.customerId) {
          throw quarantineError(
            'UNKNOWN_DEVICE',
            'device.customerId',
            'device has no customer assignment; esg_reports requires customerId',
          );
        }
        const write: ReportWrite = {
          ...baseWrite,
          customerId: attribution.customerId,
          siteId: attribution.siteId ?? '__UNASSIGNED__',
        };
        // 期间重叠：相同起点 = 相同报告（预检幂等跳过）；不同起点相交 = 拒绝
        const overlapping = await findOverlappingReport(tx, {
          deviceId,
          customerId: write.customerId,
          siteId: write.siteId,
          reportType,
          start,
          end,
        });
        if (overlapping && overlapping.periodStartTime.getTime() !== start.getTime()) {
          throw quarantineError(
            'INVALID_REPORT',
            'data.periodStartTime',
            `report period overlaps existing report (start ${overlapping.periodStartTime.toISOString()})`,
          );
        }
        if (overlapping) return { status: 'duplicate' as const };
        const inserted = await insertReport(tx, write);

        // 归档 outbox：字段与 RDS 列完整一致（buildReportRow 同源），不宣称第三方核证
        const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
        await outbox.create({
          data: {
            eventType: 'ARCHIVE',
            aggregateType: 'device',
            aggregateId: deviceId,
            payload: {
              archiveClass: 'MQTT_RAW',
              envelopeVersion: '1.0',
              aggregateId: deviceId,
              topicType: 'report',
              columns: buildReportRow(write),
              deviceId,
              customerId: attribution.customerId,
              siteId: attribution.siteId,
              occurredAt: message.occurredAt,
              receivedAtMs: message.envelope.iotReceivedAt,
              payloadHash,
              auditHash: (message.audit as Record<string, unknown> | null)?.hash ?? null,
              attestation: 'NONE',
              rawBody: message.rawBody,
              payload: message.rawPayload,
            },
          },
        });
        return inserted;
      },
    });

    if (processed.outcome === 'DUPLICATE_SKIPPED') {
      return { handled: true, outcome: processed.outcome, reportStatus: undefined, archived: false };
    }
    return {
      handled: true,
      outcome: processed.outcome,
      reportStatus: processed.result?.status,
      archived: processed.result?.status === 'created',
    };
  };
}
