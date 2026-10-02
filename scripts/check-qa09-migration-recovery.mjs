import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function validateRecovery(retirement, db, migration, upload, readback) {
  if (
    retirement.gate !== 'PASS' ||
    retirement.snapshot?.Status !== 'available' ||
    retirement.snapshot?.Encrypted !== true ||
    db.queryGate !== 'PASS' ||
    db.migrationGate !== 'PASS' ||
    db.schemaGate !== 'PASS' ||
    db.snapshot?.identity?.read_only !== 'on'
  )
    throw Error('RECOVERY_PREREQUISITE_FAILED');
  if (
    migration.buildspecRoleAndSourceAddressUnchanged !== true ||
    migration.build?.status !== 'SUCCEEDED' ||
    migration.build.sourceVersion !== upload.upload?.VersionId ||
    migration.build.expectedSourceCommit !== upload.sourceCommit ||
    migration.result?.sourceCommit !== upload.sourceCommit ||
    migration.result.buildId !== migration.build.id ||
    migration.result.migrations !== 'PASS' ||
    migration.result.dictionarySeed !== 'PASS' ||
    migration.result.verification?.schema !== 'PASS' ||
    migration.result.verification?.migrationCount !== 40
  )
    throw Error('MIGRATION_VERSION_OR_RESULT_MISMATCH');
  if (
    upload.zipSha256 !== '95773c88cb17c0de4b3bb1adea3dba74151f132887e0f2fbe9739c20da03fe55' ||
    upload.sourceCommit !== 'f63b56ed39ce99deb4b0177df9afcde386dd30df' ||
    readback.VersionId !== upload.upload.VersionId ||
    readback.ChecksumSHA256 !== upload.upload.ChecksumSHA256 ||
    readback.Metadata?.sha256 !== upload.zipSha256 ||
    readback.ContentLength !== upload.size
  )
    throw Error('ARTIFACT_READBACK_MISMATCH');
  if (
    db.manifest?.migrations?.length !== 40 ||
    db.snapshot.migrationComparison?.status !== 'PASS' ||
    db.snapshot.migrations?.filter((m) => m.finished_at && !m.rolled_back_at).length !== 40 ||
    db.snapshot.onboardingMigrationPrecheck?.status !== 'PASS' ||
    db.snapshot.counts.onboarding_requests?.count !== '0' ||
    db.snapshot.counts.onboarding_provisioning_jobs?.count !== '0' ||
    Object.hasOwn(db.snapshot.preservationFingerprints ?? {}, 'onboarding_tokens')
  )
    throw Error('LIVE_SCHEMA_OR_RETIREMENT_MISMATCH');
  const allowed = ['_prisma_migrations', 'onboarding_tokens', 'device_certificates'];
  const checked = [];
  for (const [table, before] of Object.entries(retirement.result.preservedTables)) {
    if (allowed.includes(table)) continue;
    const after = db.snapshot.preservationFingerprints?.[table];
    if (!after || after.count !== before.count || after.digest !== before.digest)
      throw Error('PRESERVED_TABLE_CHANGED:' + table);
    checked.push(table);
  }
  if (JSON.stringify(db.snapshot.certificateIdentityRows) !== JSON.stringify(retirement.result.certificateIdentityRows))
    throw Error('CERTIFICATE_IDENTITIES_CHANGED');
  if (!checked.includes('devices') || !checked.includes('users') || checked.length < 50)
    throw Error('PRESERVATION_COVERAGE_MISSING');
  return {
    task: 'QA-09',
    scope: 'APPROVED_SNAPSHOT_RETIREMENT_THREE_MIGRATIONS',
    gate: 'PASS',
    migrationCount: 40,
    preservedTablesVerified: checked.length,
    certificateIdentitiesPreserved: db.snapshot.certificateIdentityRows.length,
    snapshotArn: retirement.snapshot.DBSnapshotArn,
    retirementBuildId: retirement.build.id,
    migrationBuildId: migration.build.id,
    readOnlyBuildId: db.build.id,
    sourceCommit: upload.sourceCommit,
    sourceVersion: upload.upload.VersionId,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    console.log(
      JSON.stringify(
        validateRecovery(...process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')))),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
