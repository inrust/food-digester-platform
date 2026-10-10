export const publicGroups: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]>;
export function validateContractPublicBoundaries(
  phases: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ownership?: ReadonlyArray<Readonly<Record<string, unknown>>>,
  required?: boolean,
): {
  gate: string;
  windowsMs: Record<string, number>;
  scope: string;
  afterQueueAttribution: string;
  compilerOnlyAttribution: false;
  serverExecutionIsolated: false;
  p95Accepted: false;
} | null;
