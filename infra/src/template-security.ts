export interface PolicyStatementLocation {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly statement: Record<string, unknown>;
}

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
const wildcardAction = (value: unknown): boolean =>
  typeof value === 'string' && (value === '*' || /^[a-z0-9-]+:\*$/iu.test(value));
const wildcardResource = (value: unknown): boolean =>
  typeof value === 'string' && (value === '*' || value.includes('*') || value.includes('?'));

/** 覆盖 IAM Policy、ManagedPolicy、Role 内联 Policy 与 KMS KeyPolicy。 */
export function collectPolicyStatements(template: Record<string, any>): PolicyStatementLocation[] {
  const locations: PolicyStatementLocation[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {}) as Array<[string, any]>) {
    const documents: any[] = [];
    if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
      documents.push(resource.Properties?.PolicyDocument);
    }
    if (resource.Type === 'AWS::IAM::Role') {
      documents.push(...(resource.Properties?.Policies ?? []).map((policy: any) => policy.PolicyDocument));
    }
    if (resource.Type === 'AWS::KMS::Key') documents.push(resource.Properties?.KeyPolicy);
    for (const document of documents) {
      for (const statement of document?.Statement ?? []) {
        locations.push({ logicalId, resourceType: resource.Type, statement });
      }
    }
  }
  return locations;
}

/** 拒绝 `*` 或 `service:*` 与通配 Resource 同时出现的 Allow。 */
export function broadAllowViolations(template: Record<string, any>): PolicyStatementLocation[] {
  return collectPolicyStatements(template).filter(({ statement }) => {
    if (statement.Effect !== 'Allow') return false;
    return arrayOf(statement.Action).some(wildcardAction) && arrayOf(statement.Resource).some(wildcardResource);
  });
}

/** KMS 数据面动作不能授权给通配 Principal。 */
export function wildcardKmsPrincipalViolations(template: Record<string, any>): PolicyStatementLocation[] {
  return collectPolicyStatements(template).filter(({ resourceType, statement }) => {
    if (resourceType !== 'AWS::KMS::Key' || statement.Effect !== 'Allow') return false;
    const hasCrypto = arrayOf(statement.Action).some(
      (action) =>
        typeof action === 'string' && /^(?:kms:(?:Decrypt|Encrypt|GenerateDataKey|ReEncrypt)|kms:\*)/iu.test(action),
    );
    if (!hasCrypto) return false;
    return JSON.stringify(statement.Principal).includes('"*"');
  });
}
