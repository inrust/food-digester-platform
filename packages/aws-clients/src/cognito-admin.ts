import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserAttributesCommand,
  AdminDisableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

interface CognitoResponse {
  readonly User?: { readonly Username?: string; readonly Attributes?: readonly { Name?: string; Value?: string }[] };
  readonly Users?: readonly {
    readonly Username?: string;
    readonly Attributes?: readonly { Name?: string; Value?: string }[];
  }[];
  readonly Groups?: readonly { readonly GroupName?: string }[];
  readonly NextToken?: string;
}

interface CognitoClient {
  send(command: unknown): Promise<CognitoResponse>;
}

export interface CognitoAdminConfig {
  readonly userPoolId: string;
  readonly region?: string;
  readonly client?: CognitoClient;
}

export interface CognitoAdminPort {
  readonly inviteUser: (input: {
    readonly email: string;
    readonly groups: readonly string[];
    readonly customerId: string | null;
  }) => Promise<{ readonly cognitoSub: string }>;
  readonly setUserGroups: (input: { readonly cognitoSub: string; readonly groups: readonly string[] }) => Promise<void>;
  readonly setUserCustomerScope: (input: {
    readonly cognitoSub: string;
    readonly customerId: string | null;
  }) => Promise<void>;
  readonly disableUser: (input: { readonly cognitoSub: string }) => Promise<void>;
  readonly triggerPasswordReset: (input: { readonly cognitoSub: string }) => Promise<void>;
}

const attribute = (attributes: readonly { Name?: string; Value?: string }[] | undefined, name: string) =>
  attributes?.find((item) => item.Name === name)?.Value;

function filterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function createCognitoAdminPort(config: CognitoAdminConfig): CognitoAdminPort {
  const client: CognitoClient =
    config.client ?? new CognitoIdentityProviderClient(config.region ? { region: config.region } : {});

  const resolveUsername = async (cognitoSub: string): Promise<string> => {
    const response = await client.send(
      new ListUsersCommand({ UserPoolId: config.userPoolId, Filter: `sub = "${filterValue(cognitoSub)}"`, Limit: 2 }),
    );
    if (response.Users?.length !== 1 || !response.Users[0]?.Username) {
      throw new Error('Cognito user could not be resolved uniquely by subject');
    }
    return response.Users[0].Username;
  };

  const replaceGroups = async (username: string, groups: readonly string[]): Promise<void> => {
    const current = new Set<string>();
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new AdminListGroupsForUserCommand({ UserPoolId: config.userPoolId, Username: username, NextToken: nextToken }),
      );
      for (const group of response.Groups ?? []) if (group.GroupName) current.add(group.GroupName);
      nextToken = response.NextToken;
    } while (nextToken);
    const wanted = new Set(groups);
    for (const group of [...current].filter((name) => !wanted.has(name)).sort()) {
      await client.send(
        new AdminRemoveUserFromGroupCommand({ UserPoolId: config.userPoolId, Username: username, GroupName: group }),
      );
    }
    for (const group of [...wanted].filter((name) => !current.has(name)).sort()) {
      await client.send(
        new AdminAddUserToGroupCommand({ UserPoolId: config.userPoolId, Username: username, GroupName: group }),
      );
    }
  };

  return {
    async inviteUser(input) {
      const userAttributes = [
        { Name: 'email', Value: input.email },
        { Name: 'email_verified', Value: 'true' },
        ...(input.customerId ? [{ Name: 'custom:customer_id', Value: input.customerId }] : []),
      ];
      const response = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: config.userPoolId,
          Username: input.email,
          DesiredDeliveryMediums: ['EMAIL'],
          UserAttributes: userAttributes,
        }),
      );
      const username = response.User?.Username;
      const cognitoSub = attribute(response.User?.Attributes, 'sub');
      if (!username || !cognitoSub) throw new Error('Cognito did not return the created user subject');
      await replaceGroups(username, input.groups);
      return { cognitoSub };
    },
    async setUserGroups(input) {
      await replaceGroups(await resolveUsername(input.cognitoSub), input.groups);
    },
    async setUserCustomerScope(input) {
      const username = await resolveUsername(input.cognitoSub);
      if (input.customerId) {
        await client.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: config.userPoolId,
            Username: username,
            UserAttributes: [{ Name: 'custom:customer_id', Value: input.customerId }],
          }),
        );
      } else {
        await client.send(
          new AdminDeleteUserAttributesCommand({
            UserPoolId: config.userPoolId,
            Username: username,
            UserAttributeNames: ['custom:customer_id'],
          }),
        );
      }
    },
    async disableUser(input) {
      await client.send(
        new AdminDisableUserCommand({
          UserPoolId: config.userPoolId,
          Username: await resolveUsername(input.cognitoSub),
        }),
      );
    },
    async triggerPasswordReset(input) {
      await client.send(
        new AdminResetUserPasswordCommand({
          UserPoolId: config.userPoolId,
          Username: await resolveUsername(input.cognitoSub),
        }),
      );
    },
  };
}
