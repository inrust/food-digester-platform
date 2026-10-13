import { resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createAggregationWorker } from '../aggregation/worker.js';
import type { AggregationRunResult, AggregationWindow } from '../aggregation/worker.js';
import type { AggregationRunObservation } from '../aggregation/worker.js';
import { createRedactingLogger } from '@fdp/observability';
const logger = createRedactingLogger(console);

const DEFAULT_LOOKBACK_HOURS = 48;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

export function aggregationWindow(now: Date, lookbackHours = DEFAULT_LOOKBACK_HOURS): AggregationWindow {
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 31) {
    throw new Error('SUMMARY_LOOKBACK_HOURS 必须是 1..744 的整数');
  }
  const to = new Date(now);
  to.setUTCMinutes(59, 59, 999);
  return { from: new Date(to.getTime() - lookbackHours * 3_600_000 + 1), to };
}

export interface SummaryScheduleEvent {
  readonly time?: string;
  readonly id?: string;
  readonly source?: string;
  readonly resources?: readonly string[];
}

/** EventBridge 的事件时间是重算窗口锚点；缺失时才回退到当前 UTC 时间。 */
export function eventTimeOf(event: SummaryScheduleEvent | undefined, fallback: () => Date = () => new Date()): Date {
  if (event?.time === undefined) return fallback();
  const time = new Date(event.time);
  if (Number.isNaN(time.getTime())) throw new Error('EventBridge time 必须是有效 ISO-8601 时间');
  return time;
}

let recompute:
  ((window: AggregationWindow, observation?: AggregationRunObservation) => Promise<AggregationRunResult>) | undefined;

export function summaryObservation(
  event: SummaryScheduleEvent | undefined,
  time: Date,
  context: { readonly awsRequestId?: string } | undefined,
  observe: (row: Record<string, unknown>) => void,
): AggregationRunObservation {
  return {
    lambdaRequestId: context?.awsRequestId ?? null,
    eventId: event?.id ?? null,
    eventTime: time.toISOString(),
    source: event?.source === 'aws.events' && event.id ? 'aws.events' : 'MANUAL_OR_UNRECOGNIZED',
    ruleName: event?.resources?.[0]?.split('/').at(-1) ?? null,
    observe,
  };
}

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  return createAggregationWorker({ client }).recomputeWindow;
}

export async function handler(
  event?: SummaryScheduleEvent,
  context?: { readonly awsRequestId?: string },
): Promise<AggregationRunResult> {
  recompute ??= await initialize();
  const rawLookback = process.env.SUMMARY_LOOKBACK_HOURS;
  const lookbackHours = rawLookback === undefined ? DEFAULT_LOOKBACK_HOURS : Number(rawLookback);
  const eventTime = eventTimeOf(event),
    window = aggregationWindow(eventTime, lookbackHours);
  const observation = summaryObservation(event, eventTime, context, (row) => logger.info(JSON.stringify(row)));
  const result = await recompute(window, observation);
  logger.info(
    JSON.stringify({
      event: 'summary.run.completed',
      schemaVersion: 1,
      lambdaRequestId: observation.lambdaRequestId,
      eventId: observation.eventId,
      eventTime: observation.eventTime,
      source: observation.source,
      ruleName: observation.ruleName,
      ...result,
    }),
  );
  return result;
}
