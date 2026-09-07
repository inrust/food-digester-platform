import { resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { createAggregationWorker } from '../aggregation/worker.js';
import type { AggregationRunResult, AggregationWindow } from '../aggregation/worker.js';

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
}

/** EventBridge 的事件时间是重算窗口锚点；缺失时才回退到当前 UTC 时间。 */
export function eventTimeOf(event: SummaryScheduleEvent | undefined, fallback: () => Date = () => new Date()): Date {
  if (event?.time === undefined) return fallback();
  const time = new Date(event.time);
  if (Number.isNaN(time.getTime())) throw new Error('EventBridge time 必须是有效 ISO-8601 时间');
  return time;
}

let recompute: ((window: AggregationWindow) => Promise<AggregationRunResult>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  return createAggregationWorker({ client }).recomputeWindow;
}

export async function handler(event?: SummaryScheduleEvent): Promise<AggregationRunResult> {
  recompute ??= await initialize();
  const rawLookback = process.env.SUMMARY_LOOKBACK_HOURS;
  const lookbackHours = rawLookback === undefined ? DEFAULT_LOOKBACK_HOURS : Number(rawLookback);
  return recompute(aggregationWindow(eventTimeOf(event), lookbackHours));
}
