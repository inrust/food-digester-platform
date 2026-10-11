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
export function validateCpuProfile(p: any): { at: number; bucket: string }[];
export function attributeCpuSamples(points: { at: number; bucket: string }[], spans: any[]): any[];
export function summarizeCpuCase(r: any): any;
