export function validateContractLoadSplit(
  phases: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ownership?: ReadonlyArray<Readonly<Record<string, unknown>>>,
  required?: boolean,
): {
  gate: 'PASS';
  delegateMs: number;
  ormPrepareMs: number;
  driverQueryMs: number;
  resultMs: number;
  loadMs: number;
  scope: 'PUBLIC_MODEL_EXTENSION_TO_TRANSACTION_ADAPTER_NOT_COMPILER_OR_SERVER_ONLY';
  causalBenefit: 'NOT_ESTABLISHED';
} | null;
