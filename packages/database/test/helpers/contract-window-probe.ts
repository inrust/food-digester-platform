import { performance } from 'node:perf_hooks';
/** Offline only: no runtime export, SQL, timers, scheduling, or logging; disabled by default. */
export function createContractWindowProbe(requestId: string, enabled = false) {
  const start = performance.now(),
    cpu = process.cpuUsage();
  const marks: {
    name: string;
    requestId: string;
    us: number;
    cpuUserUs: number;
    cpuSystemUs: number;
    scope: string;
    wallMs: number;
  }[] = [];
  return {
    marks,
    mark(name: string) {
      if (!enabled) return;
      const used = process.cpuUsage(cpu);
      marks.push({
        wallMs: Date.now(),
        name,
        requestId,
        us: Math.round((performance.now() - start) * 1000),
        cpuUserUs: used.user,
        cpuSystemUs: used.system,
        scope: 'PROCESS_ALL_THREADS',
      });
    },
  };
}
