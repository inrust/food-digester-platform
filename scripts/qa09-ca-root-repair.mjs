import { isDeepStrictEqual } from 'node:util';
import { diagnoseCaChain } from './qa09-ca-chain-diagnostic.mjs';
const certificates = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
function requireThat(ok, code) {
  if (!ok) throw Error(code);
}
function comparable(value) {
  const result = structuredClone(value);
  delete result.caCertificateChainPem;
  return result;
}
/** AWS-only runtime. No real Secret string may be supplied from or returned to the workstation. */
export async function repairCaRoot({
  store,
  baselineVersion,
  token,
  truststorePem,
  rootFingerprint,
  now = new Date(),
}) {
  requireThat(
    /^[a-f0-9-]{36}$/.test(baselineVersion) && /^[a-f0-9-]{36}$/.test(token) && token !== baselineVersion,
    'INVALID_VERSION',
  );
  const stage = `QA09_CANDIDATE_${token}`;
  const report = {
    schema: 'fdp-qa09-ca-root-repair/v1',
    baselineVersion,
    candidateVersion: token,
    candidateStage: stage,
    completed: false,
    promoted: false,
    rolledBack: false,
    secretValuesExported: false,
    otherFieldsUnchanged: false,
    originalVersionRetained: false,
  };
  let original, candidate;
  const current = async () => {
    const metadata = await store.describe();
    const versions = Object.entries(metadata.VersionIdsToStages ?? {});
    const selected = versions.filter(([, stages]) => stages.includes('AWSCURRENT'));
    requireThat(selected.length === 1, 'CURRENT_STAGE_AMBIGUOUS');
    return { id: selected[0][0], versions: metadata.VersionIdsToStages };
  };
  const validate = (response) => {
    requireThat(response.VersionId === token, 'CANDIDATE_VERSION_MISMATCH');
    const parsed = JSON.parse(response.SecretString);
    requireThat(
      isDeepStrictEqual(parsed, candidate) && isDeepStrictEqual(comparable(parsed), comparable(original)),
      'OTHER_FIELDS_CHANGED',
    );
    const chain = diagnoseCaChain(response.SecretString, truststorePem, now);
    requireThat(
      chain.completed &&
        chain.workerChainValid &&
        chain.configuredChainEqualsTruststoreInOrder &&
        chain.privateKeyMatchesSigningCertificate,
      'CANDIDATE_CHAIN_INVALID',
    );
    report.otherFieldsUnchanged = true;
  };
  try {
    requireThat((await current()).id === baselineVersion, 'BASELINE_DRIFT');
    const response = await store.get(baselineVersion);
    requireThat(response.VersionId === baselineVersion, 'BASELINE_VERSION_MISMATCH');
    const before = diagnoseCaChain(response.SecretString, truststorePem, now);
    requireThat(
      before.completed &&
        before.truststoreChainValid &&
        before.truststoreChainCount === 2 &&
        before.configuredChainCount === 1 &&
        before.signingCertificateMatchesTruststoreFirst &&
        before.privateKeyMatchesSigningCertificate &&
        before.missingTruststoreFingerprints.length === 1 &&
        before.missingTruststoreFingerprints[0] === rootFingerprint,
      'BASELINE_CHAIN_DRIFT',
    );
    original = JSON.parse(response.SecretString);
    const blocks = truststorePem.match(certificates) ?? [];
    requireThat(blocks.length === 2 && before.truststoreChain[1].fingerprint256 === rootFingerprint, 'ROOT_DRIFT');
    candidate = structuredClone(original);
    candidate.caCertificateChainPem = blocks[1] + '\n';
    requireThat((await current()).id === baselineVersion, 'BASELINE_DRIFT');
    // An unknown outcome is recovered using the same immutable token; never mint another version.
    try {
      await store.put({ ClientRequestToken: token, VersionStages: [stage], SecretString: JSON.stringify(candidate) });
    } catch {
      validate(await store.get(token));
    }
    validate(await store.get(token));
    requireThat((await current()).id === baselineVersion, 'BASELINE_DRIFT');
    try {
      await store.move({ VersionStage: 'AWSCURRENT', MoveToVersionId: token, RemoveFromVersionId: baselineVersion });
    } catch {
      requireThat((await current()).id === token, 'PROMOTION_NOT_CONFIRMED');
    }
    requireThat((await current()).id === token, 'PROMOTION_NOT_CONFIRMED');
    report.promoted = true;
    validate(await store.get(token));
    // Re-read the immutable original as well as stages to prove retained data and rollback availability.
    const retained = await store.get(baselineVersion);
    requireThat(
      retained.VersionId === baselineVersion && isDeepStrictEqual(JSON.parse(retained.SecretString), original),
      'ORIGINAL_VERSION_CHANGED',
    );
    const metadata = await current();
    requireThat(
      metadata.id === token && metadata.versions[baselineVersion]?.includes('AWSPREVIOUS'),
      'ORIGINAL_STAGE_NOT_RETAINED',
    );
    report.originalVersionRetained = true;
    report.completed = true;
  } catch (error) {
    const allowed = [
      'INVALID_VERSION',
      'CURRENT_STAGE_AMBIGUOUS',
      'BASELINE_DRIFT',
      'BASELINE_VERSION_MISMATCH',
      'BASELINE_CHAIN_DRIFT',
      'ROOT_DRIFT',
      'CANDIDATE_VERSION_MISMATCH',
      'OTHER_FIELDS_CHANGED',
      'CANDIDATE_CHAIN_INVALID',
      'PROMOTION_NOT_CONFIRMED',
      'ORIGINAL_VERSION_CHANGED',
      'ORIGINAL_STAGE_NOT_RETAINED',
    ];
    report.errorCode = allowed.includes(error.message) ? error.message : 'AWS_REPAIR_FAILED';
    if (report.promoted) {
      try {
        requireThat((await current()).id === token, 'ROLLBACK_CURRENT_DRIFT');
        await store.move({ VersionStage: 'AWSCURRENT', MoveToVersionId: baselineVersion, RemoveFromVersionId: token });
        report.rolledBack = (await current()).id === baselineVersion;
      } catch {
        report.rollbackNeedsReview = true;
      }
    }
  } finally {
    original = undefined;
    candidate = undefined;
  }
  return report;
}
