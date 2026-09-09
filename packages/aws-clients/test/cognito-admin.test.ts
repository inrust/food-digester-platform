import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserAttributesCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { assert, describe, expect, test } from 'vitest';
import { createCognitoAdminPort } from '../src/cognito-admin.js';

describe('Cognito Admin 生产适配器', () => {
  test('邀请由 Cognito 生成凭证并整体同步组，返回真实 sub', async () => {
    const sent: unknown[] = [];
    const port = createCognitoAdminPort({
      userPoolId: 'pool-1',
      client: {
        async send(command) {
          sent.push(command);
          if (command instanceof AdminCreateUserCommand) {
            return { User: { Username: 'generated-name', Attributes: [{ Name: 'sub', Value: 'sub-1' }] } };
          }
          if (command instanceof AdminListGroupsForUserCommand) return { Groups: [] };
          return {};
        },
      },
    });
    assert.deepEqual(
      await port.inviteUser({ email: 'admin@example.com', groups: ['PlatformSuperAdmin'], customerId: null }),
      { cognitoSub: 'sub-1' },
    );
    const create = sent[0] as AdminCreateUserCommand;
    assert.equal(create.input.MessageAction, undefined);
    assert.deepEqual(create.input.DesiredDeliveryMediums, ['EMAIL']);
    assert.instanceOf(sent[1], AdminListGroupsForUserCommand);
    assert.instanceOf(sent[2], AdminAddUserToGroupCommand);
  });

  test('sub 先解析为 Username；组、Customer scope、停用与重置调用完整 Admin API', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        if (command instanceof ListUsersCommand) return { Users: [{ Username: 'user-name' }] };
        if (command instanceof AdminListGroupsForUserCommand) {
          return { Groups: [{ GroupName: 'Auditor' }, { GroupName: 'OldGroup' }] };
        }
        return {};
      },
    };
    const port = createCognitoAdminPort({ userPoolId: 'pool-1', client });
    await port.setUserGroups({ cognitoSub: 'sub-1', groups: ['Auditor', 'PlatformSuperAdmin'] });
    await port.setUserCustomerScope({ cognitoSub: 'sub-1', customerId: 'customer-1' });
    await port.setUserCustomerScope({ cognitoSub: 'sub-1', customerId: null });
    await port.disableUser({ cognitoSub: 'sub-1' });
    await port.enableUser({ cognitoSub: 'sub-1' });
    await port.deleteUser({ cognitoSub: 'sub-1' });
    await port.triggerPasswordReset({ cognitoSub: 'sub-1' });

    assert.ok(sent.some((item) => item instanceof AdminRemoveUserFromGroupCommand));
    assert.ok(sent.some((item) => item instanceof AdminAddUserToGroupCommand));
    assert.ok(sent.some((item) => item instanceof AdminUpdateUserAttributesCommand));
    assert.ok(sent.some((item) => item instanceof AdminDeleteUserAttributesCommand));
    assert.ok(sent.some((item) => item instanceof AdminDisableUserCommand));
    assert.ok(sent.some((item) => item instanceof AdminEnableUserCommand));
    assert.ok(sent.some((item) => item instanceof AdminDeleteUserCommand));
    assert.ok(sent.some((item) => item instanceof AdminResetUserPasswordCommand));
    for (const command of sent.filter((item) => !(item instanceof ListUsersCommand))) {
      if ('input' in (command as object)) {
        assert.equal((command as { input: { UserPoolId?: string } }).input.UserPoolId, 'pool-1');
      }
    }
  });

  test('sub 无法唯一解析时失败关闭，不执行管理动作', async () => {
    const port = createCognitoAdminPort({
      userPoolId: 'pool-1',
      client: {
        async send() {
          return { Users: [] };
        },
      },
    });
    await expect(port.disableUser({ cognitoSub: 'missing' })).rejects.toThrow(/uniquely/u);
  });
});
