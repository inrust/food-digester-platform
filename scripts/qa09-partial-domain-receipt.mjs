const proofKinds = new Set([
  'ATOMIC_AUDIT_SNAPSHOT',
  'CURRENT_CONTRACT_STATE_READBACK',
  'REAL_CSR_ENTITY_RECEIPT',
  'SCOPED_SIGNED_USER_AUDIT',
  'NONACTIVE_LICENSE_EVALUATION_READBACK',
]);
/** An assembled partial receipt is useful evidence, but can never become a full original-domain PASS. */
export function validatePartialDomainReceipt(receipt, expected) {
  if (
    receipt.kind !== 'PARTIAL_DOMAIN_RECEIPT_ASSEMBLY_NOT_LEGACY_PASS_RECEIPT' ||
    receipt.status !== 'PARTIAL_NOT_ACCEPTED' ||
    receipt.fullOriginalGatePassed !== false ||
    receipt.fullQa09Accepted !== false ||
    receipt.originalValidatorModified !== false ||
    receipt.validator !== expected.validator ||
    receipt.validatorSha256 !== expected.validatorSha256 ||
    JSON.stringify(receipt.requiredSets) !== JSON.stringify(expected.requiredSets)
  )
    throw Error('PARTIAL_DOMAIN_BOUNDARY_OR_REQUIRED_SET_DRIFT');
  const ops = [
    ...new Set(
      Object.entries(expected.requiredSets)
        .filter(([k, v]) => k.includes('OPERATIONS') && Array.isArray(v))
        .flatMap(([, v]) => v),
    ),
  ];
  if (
    !Array.isArray(receipt.operationCoverage) ||
    receipt.operationCoverage.length !== ops.length ||
    new Set(receipt.operationCoverage.map((o) => o.operationId)).size !== ops.length ||
    receipt.operationCoverage.some((o) => !ops.includes(o.operationId))
  )
    throw Error('EXACT_ORIGINAL_OPERATION_INVENTORY_REQUIRED');
  for (const [kind, field, key] of [
    ['WORKFLOWS', 'workflowCoverage', 'workflowId'],
    ['ROUTES', 'routeCoverage', 'route'],
  ]) {
    const required = [
      ...new Set(
        Object.entries(expected.requiredSets)
          .filter(([k, v]) => k.includes(kind) && Array.isArray(v))
          .flatMap(([, v]) => v),
      ),
    ];
    const actual = (receipt[field] ?? []).map((r) => r[key]);
    if (
      actual.length !== required.length ||
      new Set(actual).size !== required.length ||
      required.some((v) => !actual.includes(v))
    )
      throw Error('EXACT_ANCILLARY_INVENTORY_REQUIRED');
  }
  if (
    expected.probePaths &&
    (JSON.stringify(receipt.probePaths) !== JSON.stringify(expected.probePaths) ||
      JSON.stringify(receipt.probeCoverage.map((p) => p.path)) !== JSON.stringify(expected.probePaths))
  )
    throw Error('EXACT_ORIGINAL_PROBE_INVENTORY_REQUIRED');
  const scoped = [];
  for (const op of receipt.operationCoverage) {
    if (!Array.isArray(op.roleRows) || new Set(op.roleRows.map((r) => r.role)).size !== op.roleRows.length)
      throw Error('EXACT_UNIQUE_ROLE_ROWS_REQUIRED');
    for (const row of op.roleRows) {
      if (row.status === 'PASS_SCOPED_PERSISTENCE') {
        const valid = row.proofs?.some(
          (p) =>
            p.operationId === op.operationId &&
            p.role === row.role &&
            proofKinds.has(p.proofKind) &&
            p.specializedValidation === 'PASS' &&
            p.sourceCompatible === true &&
            p.cleanupVerified === true &&
            /^[a-f0-9]{64}$/.test(p.receiptSha256 ?? ''),
        );
        if (!valid) throw Error('SCOPED_PERSISTENCE_PROOF_REQUIRED');
        scoped.push(op.operationId + ':' + row.role);
      } else if (!['DEFERRED_A2_NOT_ACCEPTED', 'UNAVAILABLE_INPUT_NOT_ACCEPTED', 'NOT_PROVEN'].includes(row.status))
        throw Error('INVALID_PARTIAL_OPERATION_STATUS');
    }
  }
  if (JSON.stringify(scoped.sort()) !== JSON.stringify([...receipt.evidence.operationRoles].sort()))
    throw Error('EVIDENCE_MUST_MATCH_SCOPED_OPERATION_ROWS');
  if (
    receipt.workflowCoverage.some(
      (w) => w.status !== 'SCOPED_OBSERVATIONS_ASSEMBLED_FULL_ORIGINAL_WORKFLOW_NOT_ACCEPTED',
    ) ||
    receipt.probeCoverage.some((p) => p.status !== 'PARTIAL_SCOPED_OBSERVATIONS_NOT_FULL_ORIGINAL_PROBE')
  )
    throw Error('ANCILLARY_FIELDS_CANNOT_BE_PROMOTED');
  return { gate: 'PASS_PARTIAL_ASSEMBLY_STRUCTURE_ONLY', formalAccepted: false, fullQa09Accepted: false };
}
