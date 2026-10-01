export function scanSecurityArtifact(
  value: unknown,
  knownValues?: readonly string[],
): {
  inspectedNodes: number;
  findings: { path: string; rule: string }[];
};
