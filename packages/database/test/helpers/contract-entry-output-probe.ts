import { entryOutputPhases } from '../../../../scripts/qa09-contract-entry-output-proof.mjs';
/** Offline prototype only. No production import, Inspector, business await or diagnostic emission. */
export const entryOutputCases = [
  'default-off',
  'reference-public',
  'entry-output',
  'slow-prefix-log',
  'slow-public-call',
  'slow-resume-log',
  'slow-terminal-log',
  'throw-prefix-log',
  'throw-resume-log',
  'reentrant-resume-log',
  'pg-reject',
  'validation-reject',
  'update-reject',
  'audit-reject',
] as const;
export type EntryOutputCase = (typeof entryOutputCases)[number];
export const outputPhases = new Set(entryOutputPhases);
export type Interval = {
  ordinal: number;
  kind: 'PUBLIC_CALL' | 'OUTPUT';
  phase?: string;
  start: number;
  end: number;
  processCpuUs: number;
  threw: boolean;
};
export const monotonicUs = () => Number(process.hrtime.bigint() / 1000n);
export function burnEntryOutputCpu(ms: number) {
  const stop = monotonicUs() + ms * 1000;
  while (monotonicUs() < stop) {
    /* bounded offline control, never an optimization */
  }
}
export class EntryOutputProbe {
  private intervals: Interval[] = [];
  private depth = 0;
  private ordinal = 0;
  private overflow = 0;
  private nested = 0;
  private foreign = 0;
  private failures = 0;
  private id = '';
  private lambdaId = '';
  private calls = 0;
  constructor(
    readonly enabled: boolean,
    private readonly clock = monotonicUs,
    private readonly cpu = process.cpuUsage,
  ) {}
  sample(id: string, lambdaId = id) {
    this.intervals = [];
    this.depth = 0;
    this.ordinal = 0;
    this.overflow = 0;
    this.nested = 0;
    this.foreign = 0;
    this.failures = 0;
    this.id = id;
    this.lambdaId = lambdaId;
    this.calls = 0;
  }
  private measure<T>(kind: Interval['kind'], phase: string | undefined, work: () => T): T {
    if (this.ordinal >= 64) {
      this.overflow++;
      return work();
    }
    const ordinal = this.ordinal++;
    let start: number, cpu: NodeJS.CpuUsage;
    try {
      start = this.clock();
      cpu = this.cpu();
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(cpu.user) || !Number.isFinite(cpu.system))
        throw Error('BAD_PROBE_READING');
    } catch {
      this.failures++;
      return work();
    }
    let threw = false;
    try {
      return work();
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      try {
        const end = this.clock(),
          used = this.cpu(cpu),
          processCpuUs = used.user + used.system;
        if (Number.isFinite(end) && end >= start && Number.isFinite(processCpuUs) && processCpuUs >= 0) {
          this.intervals.push({ ordinal, kind, ...(phase ? { phase } : {}), start, end, processCpuUs, threw });
        } else this.failures++;
      } catch {
        this.failures++;
      } // Measurement failure never replaces original return/error or retries work.
    }
  }

  callPublic<T>(work: () => T): T {
    if (!this.enabled) return work();
    this.calls++;
    return this.measure('PUBLIC_CALL', undefined, work);
  }
  wrapOutput<T>(output: (row: Record<string, unknown>) => T): (row: Record<string, unknown>) => T {
    if (!this.enabled) return output;
    return (row) => {
      if (row.gatewayRequestId !== this.id || row.lambdaRequestId !== this.lambdaId) {
        this.foreign++;
        return output(row);
      }
      if (this.depth) {
        this.nested++;
        return output(row);
      }
      if (row.event !== 'data-path.phase.completed' || !outputPhases.has(String(row.phase))) return output(row);
      // Guard only recursive measurement, not original delivery or its return/error semantics.
      this.depth++;
      try {
        return this.measure('OUTPUT', String(row.phase), () => output(row));
      } finally {
        this.depth--;
      }
    };
  }
  snapshot() {
    return {
      requestId: this.id,
      lambdaRequestId: this.lambdaId,
      enabled: this.enabled,
      publicCalls: this.calls,
      overflow: this.overflow,
      nestedOutputs: this.nested,
      foreignOutputs: this.foreign,
      probeFailures: this.failures,
      intervals: [...this.intervals].sort((a, b) => a.ordinal - b.ordinal),
      diagnosticEmissions: 0,
      status: this.overflow
        ? 'TRUNCATED'
        : this.failures
          ? 'PROBE_FAILED'
          : this.foreign
            ? 'FOREIGN_SCOPE'
            : this.nested
              ? 'REENTRANT'
              : this.intervals.some((r) => r.kind === 'OUTPUT' && r.threw)
                ? 'OUTPUT_FAILED'
                : 'COMPLETE',
    };
  }
}
