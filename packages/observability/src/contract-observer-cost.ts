/** Internal bounded bookkeeping. No SQL, business values, compiler hooks or asynchronous work. */
export type OwnedObserverPoint =
  'CHECKPOINT' | 'CHECKPOINT_PHASE_READY' | 'CHECKPOINT_RETURN' | 'PUBLIC_BRIDGE_ENTER' | 'PUBLIC_CALLBACK_ENTER';
export type ObserverPoint =
  OwnedObserverPoint | 'DRIVER_DISPATCH' | 'ADAPTER_CALL_RETURNED' | 'MODEL_EXTENSION_RESUMED' | 'OPERATION_END';
type Point = ObserverPoint | 'PUBLIC_ENTER' | 'PUBLIC_EXIT';
type Interval = { start: number; end: number; cpuUs: number; kind: 'OUTPUT' | 'PUBLIC' };
export class ContractObserverCost {
  private points = new Map<Point, number>();
  private intervals: Interval[] = [];
  private slots = 0;
  private depth = 0;
  private errors = new Set<string>();
  public closed = false;
  public publicCalls = 0;
  private publicOutcome: 'NOT_OBSERVED' | 'RETURNED' | 'THREW' = 'NOT_OBSERVED';
  public overflow = 0;
  public nestedOutputs = 0;
  public foreignOutputs = 0;
  public probeFailures = 0;
  constructor(
    private readonly clock: () => number,
    private readonly cpu = process.cpuUsage,
    private readonly ownedBoundaries = false,
  ) {}
  fail(code: string) {
    this.errors.add(code);
  }
  point(point: ObserverPoint, time: number | undefined) {
    if (this.closed) return;
    if (time === undefined || !Number.isFinite(time) || time < 0) return this.fail('MISSING_BOUNDARY');
    if (this.points.has(point)) return this.fail('MISSING_BOUNDARY');
    const micros = Math.round(time * 1000);
    if (!Number.isSafeInteger(micros)) {
      this.probeFailures++;
      return this.fail('PROBE_FAILED');
    }
    if (
      ![
        'DRIVER_DISPATCH',
        'ADAPTER_CALL_RETURNED',
        'MODEL_EXTENSION_RESUMED',
        'OPERATION_END',
        ...(this.ownedBoundaries
          ? [
              'CHECKPOINT',
              'CHECKPOINT_PHASE_READY',
              'CHECKPOINT_RETURN',
              'PUBLIC_BRIDGE_ENTER',
              'PUBLIC_CALLBACK_ENTER',
            ]
          : []),
      ].includes(point)
    )
      return this.fail('MISSING_BOUNDARY');
    this.points.set(point, micros);
  }
  /** Synchronous owned call-site only. No Promise consumption, output, CPU read or forced yield. */
  ownedPoint(point: OwnedObserverPoint) {
    if (!this.ownedBoundaries || this.closed) return;
    try {
      this.point(point, this.clock());
    } catch {
      this.probeFailures++;
      this.fail('PROBE_FAILED');
    }
  }
  private measure<T>(kind: Interval['kind'], work: () => T): T {
    if (this.slots >= 64) {
      this.overflow++;
      this.fail('TRUNCATED');
      return work();
    }
    this.slots++; // Reserve before work: nested outputs cannot evict the outer public call.
    let start: number, cpu: NodeJS.CpuUsage;
    try {
      start = Math.round(this.clock() * 1000);
      cpu = this.cpu();
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        ![cpu.user, cpu.system].every((v) => Number.isFinite(v) && v >= 0)
      )
        throw Error('READING');
    } catch {
      this.probeFailures++;
      this.fail('PROBE_FAILED');
      return work();
    }
    if (kind === 'PUBLIC') this.points.set('PUBLIC_ENTER', start);
    try {
      return work();
    } finally {
      try {
        const end = Math.round(this.clock() * 1000),
          delta = this.cpu(cpu),
          cpuUs = delta.user + delta.system;
        if (Number.isSafeInteger(end) && end >= start && Number.isFinite(cpuUs) && cpuUs >= 0) {
          this.intervals.push({ start, end, cpuUs, kind });
          if (kind === 'PUBLIC') this.points.set('PUBLIC_EXIT', end);
        } else {
          this.probeFailures++;
          this.fail('PROBE_FAILED');
        }
      } catch {
        this.probeFailures++;
        this.fail('PROBE_FAILED');
      }
    }
  }
  publicCall<T>(work: () => T): T {
    if (this.closed) return work();
    this.publicCalls++;
    if (this.publicCalls !== 1) {
      this.fail('DUPLICATE_PUBLIC_CALL');
      return work();
    }
    return this.measure('PUBLIC', () => {
      try {
        this.ownedPoint('PUBLIC_CALLBACK_ENTER');
        const value = work();
        this.publicOutcome = 'RETURNED';
        return value;
      } catch (error) {
        this.publicOutcome = 'THREW';
        throw error;
      }
    });
  }
  output<T>(work: () => T): T {
    if (this.closed) return work();
    if (this.depth) {
      this.nestedOutputs++;
      this.fail('REENTRANT');
      return work();
    }
    this.depth++;
    try {
      return this.measure('OUTPUT', () => {
        try {
          return work();
        } catch (error) {
          this.fail('OUTPUT_FAILED');
          throw error;
        }
      });
    } finally {
      this.depth--;
    }
  }
  foreign() {
    this.foreignOutputs++;
    this.fail('FOREIGN_SCOPE');
  }
  summary(ids: { gatewayRequestId: string; lambdaRequestId: string; operationId: string }, ownership: boolean) {
    this.closed = true;
    if (!ownership) this.fail('OWNERSHIP_INVALID');
    const pairs = [
      ['driver-prefix', 'DRIVER_DISPATCH', 'PUBLIC_ENTER'],
      ['public-call', 'PUBLIC_ENTER', 'PUBLIC_EXIT'],
      ['driver-return-tail', 'PUBLIC_EXIT', 'ADAPTER_CALL_RETURNED'],
      ['after-model', 'MODEL_EXTENSION_RESUMED', 'OPERATION_END'],
    ] as const;
    const spans: {
      name: string;
      lower: number;
      upper: number;
      wallUs: number;
      outputWallUs: number;
      outputProcessCpuUs: number;
      unattributedWallUs: number | null;
    }[] = [];
    for (const [name, from, to] of pairs) {
      const lower = this.points.get(from),
        upper = this.points.get(to);
      if (lower === undefined || upper === undefined || upper < lower) {
        this.fail('MISSING_BOUNDARY');
        continue;
      }
      spans.push({
        name,
        lower,
        upper,
        wallUs: upper - lower,
        outputWallUs: 0,
        outputProcessCpuUs: 0,
        unattributedWallUs: null,
      });
    }
    if (spans.some((s, i) => i > 0 && s.lower < spans[i - 1]!.upper)) this.fail('MISSING_BOUNDARY');
    const outputs = this.intervals.filter((i) => i.kind === 'OUTPUT').sort((a, b) => a.start - b.start);
    let outsideOutputs = 0,
      ambiguousOutputs = 0,
      unresolvedOutputs = 0;
    for (const [i, r] of outputs.entries()) {
      if (i && r.start < outputs[i - 1]!.end) this.fail('REENTRANT');
      if (spans.length !== 4) {
        unresolvedOutputs++;
        continue;
      }
      const owners = spans.filter((s) => r.start >= s.lower && r.end <= s.upper);
      if (owners.length === 1) {
        owners[0]!.outputWallUs += r.end - r.start;
        owners[0]!.outputProcessCpuUs += r.cpuUs;
      } else if (owners.length > 1 || spans.some((s) => r.start < s.upper && r.end > s.lower)) {
        ambiguousOutputs++;
        this.fail('AMBIGUOUS');
      } else outsideOutputs++;
    }
    for (const s of spans) if (s.outputWallUs > s.wallUs) this.fail('AMBIGUOUS');
    // These are self-owned call sites, not an adapter/compiler-internal entry.
    // Output/probe overhead is included. No CPU or log cost is subtracted here.
    const ownedPairs = [
      ['checkpoint-phase-setup', 'CHECKPOINT', 'CHECKPOINT_PHASE_READY'],
      ['checkpoint-output-return', 'CHECKPOINT_PHASE_READY', 'CHECKPOINT_RETURN'],
      ['after-checkpoint-to-dispatch', 'CHECKPOINT_RETURN', 'DRIVER_DISPATCH'],
      ['repository-driver-setup', 'DRIVER_DISPATCH', 'PUBLIC_BRIDGE_ENTER'],
      ['observer-public-bridge', 'PUBLIC_BRIDGE_ENTER', 'PUBLIC_ENTER'],
      ['public-callback-setup', 'PUBLIC_ENTER', 'PUBLIC_CALLBACK_ENTER'],
    ] as const;
    const ownedSegments: { name: string; wallUs: number }[] = [];
    if (this.ownedBoundaries) {
      for (const [name, from, to] of ownedPairs) {
        const lower = this.points.get(from),
          upper = this.points.get(to);
        if (lower === undefined || upper === undefined || upper < lower) this.fail('MISSING_BOUNDARY');
        else ownedSegments.push({ name, wallUs: upper - lower });
      }
      const callback = this.points.get('PUBLIC_CALLBACK_ENTER'),
        exit = this.points.get('PUBLIC_EXIT');
      if (callback === undefined || exit === undefined || callback > exit) this.fail('MISSING_BOUNDARY');
    }
    const order = [
      'TRUNCATED',
      'PROBE_FAILED',
      'FOREIGN_SCOPE',
      'REENTRANT',
      'OUTPUT_FAILED',
      'OWNERSHIP_INVALID',
      'DUPLICATE_PUBLIC_CALL',
      'MISSING_BOUNDARY',
      'AMBIGUOUS',
    ];
    const status = order.find((s) => this.errors.has(s)) ?? 'COMPLETE';
    return {
      event: 'data-path.contract-load.observer-cost',
      schemaVersion: this.ownedBoundaries ? 2 : 1,
      ...(this.ownedBoundaries
        ? {
            ownedBoundaries: {
              seam: 'SELF_OWNED_CALL_SITES',
              afterQueueWallUs:
                this.points.has('CHECKPOINT') && this.points.has('DRIVER_DISPATCH')
                  ? this.points.get('DRIVER_DISPATCH')! - this.points.get('CHECKPOINT')!
                  : null,
              includesObservationOverhead: true,
              segments: ownedSegments,
            },
          }
        : {}),
      ...ids,
      status,
      intervalRecords: this.intervals.length,
      publicCalls: this.publicCalls,
      publicOutcome: this.publicOutcome,
      overflow: this.overflow,
      nestedOutputs: this.nestedOutputs,
      foreignOutputs: this.foreignOutputs,
      probeFailures: this.probeFailures,
      segments: spans.map(({ lower: _lower, upper: _upper, ...s }) => ({
        ...s,
        unattributedWallUs: status === 'COMPLETE' ? s.wallUs - s.outputWallUs : null,
      })),
      outsideOutputs,
      ambiguousOutputs,
      unresolvedOutputs,
      processCpuScope: 'PROCESS_ALL_THREADS',
      cpuSubtractionAllowed: false,
      compilerOnlyAttribution: false,
    };
  }
}
