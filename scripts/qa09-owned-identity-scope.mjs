export function assertOwnUnseededIdentity(parent) {
  const username = parent.prefix + '-platformsuperadmin@example.invalid';
  if (
    parent.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    parent.gate !== 'FAIL' ||
    parent.target?.accountId !== '065986019555' ||
    parent.target.region !== 'ap-southeast-1' ||
    !parent.finishedAt ||
    !Number.isFinite(Date.parse(parent.startedAt)) ||
    !Number.isFinite(Date.parse(parent.finishedAt)) ||
    Date.parse(parent.finishedAt) < Date.parse(parent.startedAt) ||
    !/^qa09-[a-f0-9]{16}$/.test(parent.prefix) ||
    !Array.isArray(parent.customers) ||
    parent.customers.length ||
    !Array.isArray(parent.databaseBuilds) ||
    parent.databaseBuilds.length ||
    parent.identity?.username !== username ||
    parent.identity.created !== true
  )
    throw Error('OWN_UNSEEDED_IDENTITY_LEDGER_REQUIRED');
  return username;
}
export function assertOwnIdentityMetadata(parent, user) {
  const username = assertOwnUnseededIdentity(parent),
    created = Date.parse(user.UserCreateDate);
  if (
    !Number.isFinite(created) ||
    (user.UserAttributes ?? []).find((a) => a.Name === 'email')?.Value !== username ||
    created < Date.parse(parent.startedAt) - 5000 ||
    created > Date.parse(parent.finishedAt) + 5000
  )
    throw Error('IDENTITY_CREATION_SCOPE_DRIFT');
  return username;
}
