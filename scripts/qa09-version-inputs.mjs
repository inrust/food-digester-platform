/** Explicit target binding; changing expected SHA never bypasses version/artifact checks. */
export function qa09VersionInputs(env = process.env) {
  const commit = env.QA09_EXPECTED_COMMIT ?? 'e759626a3e965cd9c0330b8e73bc713c0386d7de';
  const deployRunId = env.QA09_DEPLOY_RUN_ID ?? '37078759214';
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[1-9][0-9]{0,19}$/.test(deployRunId))
    throw Error('INVALID_QA09_VERSION_BINDING');
  return { commit, deployRunId };
}
