export function validateContractLoadDetail(
  phases: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ownership?: ReadonlyArray<Readonly<Record<string, unknown>>>,
  required?: boolean,
): {
  gate: 'PASS';
  windowsMs: Record<string, number>;
  scope: string;
  compilerOnlyAttribution: false;
  serverExecutionIsolated: false;
  p95Accepted: false;
} | null;
