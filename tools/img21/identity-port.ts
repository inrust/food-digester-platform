import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { TARGET, requireThat } from './contracts.js';
import type { CognitoIdentity } from './controlled-writer.js';
interface Transport {
  send(command: any, options: { abortSignal: AbortSignal }): Promise<any>;
}
export function createIdentityPort(
  transport: Transport = new CognitoIdentityProviderClient({ region: TARGET.region, maxAttempts: 1 }),
) {
  return async (username: string): Promise<CognitoIdentity> => {
    const user = await transport.send(new AdminGetUserCommand({ UserPoolId: TARGET.poolId, Username: username }), {
      abortSignal: AbortSignal.timeout(8000),
    });
    const groups = await transport.send(
      new AdminListGroupsForUserCommand({ UserPoolId: TARGET.poolId, Username: username, Limit: 2 }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    const attr = (name: string) =>
      user.UserAttributes?.find((a: { Name: string; Value?: string }) => a.Name === name)?.Value;
    requireThat(
      !groups.NextToken &&
        user.Username === username &&
        typeof attr('sub') === 'string' &&
        typeof attr('email') === 'string' &&
        user.UserCreateDate instanceof Date &&
        typeof user.Enabled === 'boolean',
      'INVALID_COGNITO_METADATA',
    );
    return {
      username: user.Username,
      sub: attr('sub'),
      email: attr('email'),
      enabled: user.Enabled,
      createdAtMs: user.UserCreateDate.getTime(),
      groups: (groups.Groups ?? []).map((g: { GroupName?: string }) => g.GroupName),
      customerId: attr('custom:customer_id') || null,
    };
  };
}
