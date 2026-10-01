export interface PlannedMessage {
  id: string;
  stage: 'normal' | 'history' | 'burst';
  type: 'telemetry' | 'heartbeat';
  device: number;
  seq: number;
  due: number;
  occurred: number;
  duplicate: boolean;
  reordered: boolean;
}
export interface LoadPlan {
  profile: string;
  config: { normalSeconds: number; historyWindowSeconds: number; burstSeconds: number; timeScale: number };
  deviceCount: number;
  telemetrySeconds: number;
  heartbeatSeconds: number;
  historyHours: number;
  historyExecutedSeconds: number;
  burstMultiplier: number;
  uniqueTelemetry: number;
  uniqueHeartbeat: number;
  duplicates: number;
  reordered: number;
  messages: PlannedMessage[];
}
export interface Aggregate {
  key: string;
  sampleCount: number;
  avg: number;
  min: number;
  max: number;
}
export const PROFILES: Record<string, LoadPlan['config']>;
export function buildLoadPlan(profile?: string): LoadPlan;
export function latencySummary(samples: number[]): { samples: number; p95Ms: number; maxMs: number };
export function expectedAggregates(
  records: { type: string; deviceId: string; ts: string; value: number }[],
): Aggregate[];
export function checkConsistency(
  expected: Aggregate[],
  actual: Aggregate[],
): { buckets: number; samples: number; duplicateBusinessRows: number };
