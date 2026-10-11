import { Session } from 'node:inspector/promises';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CpuConfig } from '../../../../scripts/qa09-contract-cpu-proof.mjs';

export const monoUs = () => Number(process.hrtime.bigint() / 1000n);
type Bracket = { lower: number; upper: number };
type Span = { phase: string; start: Bracket; end?: Bracket; failed?: boolean; sharedEnd?: boolean };
// Controlled CPU, deliberately named in the public profiler; never treated as compiler work.
function controlledCpuProbe(milliseconds: number) {
  const end = monoUs() + milliseconds * 1000;
  let value = 0;
  while (monoUs() < end) value = (value + 1) % 1000003;
  return value;
}
export class CpuProbe {
  private boundaries = new WeakMap<object, Bracket>();
  private spans: Span[] = [];
  private index = -1;
  private id = '';
  private session: Session | undefined;
  private startBracket: Bracket | undefined;
  private measurements: Record<string, unknown>[] = [];
  private controls: Record<string, unknown>[] = [];
  private returned = 0;
  constructor(private readonly config: CpuConfig) {}
  capture(value: object | undefined, lower: number, upper: number) {
    if (value) this.boundaries.set(value, { lower, upper });
  }
  begin(phase: string, boundary: object | undefined): Span | undefined {
    if (this.index < 0 || !phase.startsWith('contract-load')) return;
    const start = boundary && this.boundaries.get(boundary);
    if (!start) return; // Only exported, shared boundaries are attributed.
    const span = { phase, start };
    this.spans.push(span);
    return span;
  }
  finish(span: Span | undefined, boundary: object | undefined, failed: boolean) {
    if (!span || span.end) return;
    const shared = boundary && this.boundaries.get(boundary);
    const now = monoUs();
    span.end = shared || { lower: now, upper: now };
    span.sharedEnd = !!shared;
    span.failed = failed;
  }
  private burn(location: string, milliseconds: number) {
    if (!milliseconds) return;
    const start = monoUs(),
      cpu = process.cpuUsage();
    controlledCpuProbe(milliseconds);
    const end = monoUs(),
      usage = process.cpuUsage(cpu);
    this.controls.push({
      location,
      index: this.index,
      requestId: this.id,
      start,
      end,
      processCpuUs: usage.user + usage.system,
    });
  }
  checkpoint(phase: string) {
    if (phase === 'contract-load-await-after-queue') this.burn('checkpoint', this.config.checkpointCpuMs);
  }
  adapterSubmit() {
    this.burn('adapter-submit', this.config.adapterCpuMs);
  }
  adapterReturned(_original: unknown) {
    this.returned++;
  }
  pgSubmit() {
    this.burn('pg-submit', this.config.pgCpuMs);
  }
  fields() {
    this.burn('fields', this.config.fieldsCpuMs);
  }
  log(row: Record<string, unknown>) {
    if (row.phase === 'contract-load-result-to-model') this.burn('resume-log', this.config.resumeCpuMs);
  }
  sample(index: number, id: string) {
    this.index = index;
    this.id = id;
    this.spans = [];
  }
  endSample() {
    const result = this.spans;
    this.index = -1;
    return result;
  }
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = monoUs(),
      cpu = process.cpuUsage();
    try {
      return await work();
    } finally {
      const usage = process.cpuUsage(cpu);
      this.measurements.push({ name, start, end: monoUs(), processCpuUs: usage.user + usage.system });
    }
  }
  async start() {
    if (!this.config.profile) return;
    const session = new Session();
    this.session = session;
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
    const lower = monoUs();
    await session.post('Profiler.start');
    this.startBracket = { lower, upper: monoUs() };
  }
  async stop() {
    if (!this.session) return null;
    const lower = monoUs();
    const { profile } = await this.session.post('Profiler.stop');
    const stopBracket = { lower, upper: monoUs() };
    const originalSha256 = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const nodes = profile.nodes.map((node) => {
      let url = node.callFrame.url;
      if (url.startsWith('file://')) url = fileURLToPath(url);
      if (url.startsWith(process.cwd() + '/')) url = relative(process.cwd(), url);
      else if (url.startsWith('/') || (url && !url.startsWith('node:') && !url.startsWith('internal/')))
        url = 'external:' + createHash('sha256').update(url).digest('hex').slice(0, 16);
      return {
        id: node.id,
        callFrame: {
          functionName: node.callFrame.functionName.slice(0, 160),
          url,
          lineNumber: node.callFrame.lineNumber,
          columnNumber: node.callFrame.columnNumber,
        },
      };
    });
    return {
      startTime: profile.startTime,
      endTime: profile.endTime,
      nodes,
      samples: profile.samples ?? [],
      timeDeltas: profile.timeDeltas ?? [],
      startBracket: this.startBracket,
      stopBracket,
      originalSha256,
      intervalUs: 1000,
      clockToleranceUs: 100,
      scope: 'V8_MAIN_ISOLATE_LOCATION_SAMPLES_NOT_CPU_TIME',
    };
  }
  receipt() {
    return { measurements: this.measurements, controls: this.controls, adapterReturns: this.returned };
  }
  async close() {
    this.session?.disconnect();
    this.session = undefined;
  }
}
