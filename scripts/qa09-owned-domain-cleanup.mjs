import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const bucket = 'fdp-test-raw-065986019555';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function closedDomainPrefixes(r) {
  if (
    r.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    r.target?.accountId !== '065986019555' ||
    r.target.region !== 'ap-southeast-1' ||
    !/^qa09-[a-f0-9]{16}$/.test(r.prefix) ||
    !r.finishedAt ||
    !r.cleanup?.length ||
    r.cleanup.some((c) => c.result !== 'PASS') ||
    !r.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10) ||
    r.customers?.length !== 2 ||
    new Set(r.customers.map((c) => c.id)).size !== 2 ||
    r.customers.some(
      (c, i) =>
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.id) ||
        c.name !== `${r.prefix}-${i === 0 ? 'a' : 'b'}` ||
        !r.cleanup.some((x) => x.type === 'customer' && x.id === c.id),
    )
  )
    throw Error('CLOSED_OWN_CUSTOMER_LEDGER_REQUIRED');
  return r.customers.map((c) => `domain/entity_type=license/customer_id=${c.id}/`);
}
export function validateDomainVersions(rows, prefixes) {
  if (rows.length > 10000 || rows.some((r) => !prefixes.some((p) => r.Key.startsWith(p)) || !r.VersionId))
    throw Error('DOMAIN_ARCHIVE_SCOPE_DRIFT');
  return rows.map((r) => ({ Key: r.Key, VersionId: r.VersionId }));
}
function aws(args, profile = 'esgiot-infra') {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (r.status !== 0) throw Error('DOMAIN_ARCHIVE_AWS_OPERATION_FAILED');
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
export async function cleanupOwnedDomain(parentFile, output) {
  const parentBytes = readFileSync(parentFile),
    parent = JSON.parse(parentBytes);
  const prefixes = closedDomainPrefixes(parent);
  const source = readFileSync(new URL('./qa09-owned-domain-cleanup.mjs', import.meta.url));
  const r = {
    task: 'QA-09',
    scope: 'CLOSED_OWN_LICENSE_DOMAIN_ARCHIVE_CLEANUP',
    prefix: parent.prefix,
    parentReceipt: parentFile,
    parentReceiptSha256: hash(parentBytes),
    sourceHash: hash(source),
    sourceBase64: source.toString('base64'),
    startedAt: new Date().toISOString(),
    bucket,
    prefixes,
    deleted: [],
    observations: [],
    gate: 'RUNNING',
    credentialsExported: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  const list = (p) => {
    const rows = [];
    let key, version;
    do {
      const page = aws(
        [
          's3api',
          'list-object-versions',
          '--bucket',
          bucket,
          '--prefix',
          p,
          '--no-paginate',
          ...(key ? ['--key-marker', key, '--version-id-marker', version] : []),
        ],
        'esgiot-readonly',
      );
      rows.push(...(page.Versions ?? []), ...(page.DeleteMarkers ?? []));
      validateDomainVersions(rows, [p]);
      key = page.IsTruncated ? page.NextKeyMarker : undefined;
      version = page.NextVersionIdMarker;
    } while (key);
    return validateDomainVersions(rows, [p]);
  };
  save();
  const dir = mkdtempSync(join(tmpdir(), 'qa09-domain-cleanup-'));
  try {
    if (aws(['sts', 'get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
    const owned = prefixes.flatMap(list);
    for (let i = 0; i < owned.length; i += 1000) {
      const file = join(dir, 'delete.json'),
        objects = owned.slice(i, i + 1000);
      writeFileSync(file, JSON.stringify({ Objects: objects, Quiet: false }));
      const result = aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', 'file://' + file]);
      if (result.Errors?.length || result.Deleted?.length !== objects.length)
        throw Error('DOMAIN_ARCHIVE_DELETE_INCOMPLETE');
      r.deleted.push(...objects);
      save();
    }
    for (const p of prefixes) {
      const remaining = list(p);
      r.observations.push({ prefix: p, versionsRemaining: remaining.length });
      if (remaining.length) throw Error('DOMAIN_ARCHIVE_REMAINS');
    }
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'DOMAIN_ARCHIVE_CLEANUP_FAILED';
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.finishedAt = new Date().toISOString();
    save();
  }
  if (r.gate !== 'PASS') throw Error('DOMAIN_ARCHIVE_CLEANUP_FAILED');
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw Error('PARENT_RECEIPT_AND_OUTPUT_REQUIRED');
  const r = await cleanupOwnedDomain(process.argv[2], process.argv[3]);
  console.log(
    JSON.stringify({ gate: r.gate, prefix: r.prefix, deletedVersions: r.deleted.length, observations: r.observations }),
  );
}
