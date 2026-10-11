import { monoUs } from './contract-cpu-probe.js';

/** Test-only exported ports. No compiler hook, yield, Promise wrapper, SQL or runtime import. */
export class DispatchProbe {
  private boundaries = new WeakMap<object, ReturnType<DispatchProbe['reading']>>();
  private marks: Record<string, unknown>[] = [];
  private controls: Record<string, unknown>[] = [];
  private id = '';
  constructor(readonly enabled: boolean) {}
  private reading() {
    const lower = monoUs(),
      cpu = process.cpuUsage(),
      upper = monoUs();
    return { lower, upper, cpuUserUs: cpu.user, cpuSystemUs: cpu.system };
  }
  capture(value: object | undefined, lower: number, upper: number, cpu: NodeJS.CpuUsage) {
    if (this.enabled && this.id && value)
      this.boundaries.set(value, { lower, upper, cpuUserUs: cpu.user, cpuSystemUs: cpu.system });
  }
  sample(id: string) {
    this.id = id;
    this.marks = [];
    this.controls = [];
  }
  mark(name: string, boundary?: object) {
    if (!this.enabled || !this.id) return;
    const value = boundary ? this.boundaries.get(boundary) : this.reading();
    if (!value) throw Error('OFFLINE_SHARED_BOUNDARY_REQUIRED');
    this.marks.push({ name, requestId: this.id, ...value });
  }
  burn(location: string, enabled: boolean) {
    if (!enabled || !this.enabled || !this.id) return;
    const start = this.reading();
    const end = monoUs() + 20000;
    while (monoUs() < end) {
      /* bounded injected CPU, never compiler attribution */
    }
    const finish = this.reading();
    this.controls.push({ location, requestId: this.id, start, finish });
  }
  snapshot() {
    return { enabled: this.enabled, requestId: this.id, marks: this.marks, controls: this.controls };
  }
}
