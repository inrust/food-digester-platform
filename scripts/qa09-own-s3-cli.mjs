import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function assertOwnS3Request(action, input, customerIds) {
  if (
    !['list-objects-v2', 'list-object-versions', 'delete-objects', 'delete-object'].includes(action) ||
    input.Bucket !== 'fdp-test-raw-065986019555' ||
    customerIds.length !== 2 ||
    customerIds.some((x) => !/^[a-f0-9-]{36}$/.test(x))
  )
    throw Error('FIXED_OWN_S3_SCOPE_REQUIRED');
  const prefixes = customerIds.flatMap((id) =>
    ['heartbeat', 'telemetry', 'ack'].map((type) => `raw/topic_type=${type}/customer_id=${id}/`),
  );
  const owns = (key) => typeof key === 'string' && prefixes.some((p) => key.startsWith(p));
  if (action.startsWith('list-') && !owns(input.Prefix)) throw Error('OWN_S3_PREFIX_REQUIRED');
  if (action === 'delete-object' && !owns(input.Key)) throw Error('OWN_S3_KEY_REQUIRED');
  if (
    action === 'delete-objects' &&
    (!input.Delete?.Objects?.length ||
      input.Delete.Objects.length > 1000 ||
      input.Delete.Objects.some((x) => !owns(x.Key) || !x.VersionId))
  )
    throw Error('EXACT_OWN_S3_VERSIONS_REQUIRED');
  if (input.KeyMarker && !owns(input.KeyMarker)) throw Error('OWN_S3_MARKER_REQUIRED');
}
export function callOwnS3Cli(action, input, customerIds) {
  assertOwnS3Request(action, input, customerIds);
  const dir = mkdtempSync(join(tmpdir(), 'qa09-own-s3-'));
  try {
    const file = join(dir, 'input.json');
    const bounded = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
    if (action.startsWith('list-')) bounded.MaxKeys = Math.min(bounded.MaxKeys ?? 100, 100);
    writeFileSync(file, JSON.stringify(bounded));
    const x = spawnSync(
      'aws',
      [
        's3api',
        action,
        '--cli-input-json',
        'file://' + file,
        '--profile',
        action.startsWith('list-') ? 'esgiot-readonly' : 'esgiot-infra',
        '--region',
        'ap-southeast-1',
        '--no-cli-pager',
        '--no-paginate',
        '--output',
        'json',
        '--cli-connect-timeout',
        '5',
        '--cli-read-timeout',
        '60',
      ],
      {
        encoding: 'utf8',
        timeout: 150000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AWS_MAX_ATTEMPTS: action.startsWith('list-') ? '3' : '1' },
      },
    );
    if (x.status !== 0)
      throw Object.assign(Error('OWN_S3_CLI_OPERATION_FAILED'), {
        code:
          x.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ??
          (x.error?.code === 'ETIMEDOUT' ? 'S3_TRANSFER_TIMEOUT' : 'S3_CLI_FAILED'),
      });
    return x.stdout.trim() ? JSON.parse(x.stdout) : {};
  } finally {
    rmSync(dir, { recursive: true });
  }
}
