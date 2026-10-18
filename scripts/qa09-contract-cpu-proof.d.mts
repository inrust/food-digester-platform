export interface CpuConfig {
  profile: boolean;
  waitMs: number;
  checkpointCpuMs: number;
  adapterCpuMs: number;
  pgCpuMs: number;
  fieldsCpuMs: number;
  resumeCpuMs: number;
}
export const cpuCases: Readonly<Record<string, CpuConfig>>;
export function alignCpuClock(input: {
  startTime: number;
  endTime: number;
  startBracket: { lower: number; upper: number };
  stopBracket: { lower: number; upper: number };
}): {
  rawClock: { startTime: number; endTime: number };
  clockMapping: {
    scope: string;
    lowerOffsetUs: number;
    upperOffsetUs: number;
    uncertaintyUs: number;
  };
  startTime: number;
  endTime: number;
};
export function validateCpuProfile(p: any): { at: number; bucket: string; uncertaintyUs?: number }[];
export function attributeCpuSamples(
  points: { at: number; bucket: string; uncertaintyUs?: number }[],
  spans: any[],
): any[];
export function summarizeCpuCase(r: any): any;
