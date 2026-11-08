/** Local bundling only. No CDK, deployment, network or manifest activation. */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const requireAws = createRequire(new URL('../../packages/aws-clients/package.json', import.meta.url));
const output = resolve(root, process.argv[2] ?? 'build/img21-mc01');
if (!output.startsWith(resolve(root, 'build/') + '/')) throw Error('LOCAL_BUILD_DIRECTORY_REQUIRED');
mkdirSync(output, { recursive: true });
const alias = Object.fromEntries(
  ['auth', 'aws-clients', 'database', 'domain', 'observability'].map((p) => [
    '@fdp/' + p,
    resolve(root, 'packages/' + p + '/src/index.ts'),
  ]),
);
for (const p of ['@aws-sdk/client-cognito-identity-provider', '@aws-sdk/client-secrets-manager'])
  alias[p] = requireAws.resolve(p);
const records = [];
for (const kind of ['writer', 'verifier']) {
  const outfile = resolve(output, kind + '.mjs');
  const built = await build({
    absWorkingDir: root,
    entryPoints: [`tools/img21/${kind}-entry.ts`],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    alias,
    metafile: true,
    sourcemap: false,
    logLevel: 'error',
    banner: {
      js: "import { createRequire as __img21Require } from 'node:module'; const require = __img21Require(import.meta.url);",
    },
  });
  const outputs = Object.values(built.metafile.outputs);
  const runtimeInputs = [
    ...new Set(
      outputs.flatMap((o) =>
        Object.entries(o.inputs)
          .filter(([, v]) => v.bytesInOutput > 0)
          .map(([p]) => p),
      ),
    ),
  ].sort();
  if (
    kind === 'verifier' &&
    runtimeInputs.some((p) =>
      /packages\/(database|aws-clients)\/src|apps\/|client-cognito|client-dynamodb|adapter-pg/.test(p),
    )
  )
    throw Error('VERIFIER_DEPENDENCY_ISOLATION_FAILED');
  const artifact = readFileSync(outfile);
  records.push({
    kind,
    path: relative(root, outfile),
    sha256: createHash('sha256').update(artifact).digest('hex'),
    bytes: artifact.length,
    runtimeInputs,
    inputs: Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .sort()
        .map((p) => [
          p,
          createHash('sha256')
            .update(readFileSync(resolve(root, p)))
            .digest('hex'),
        ]),
    ),
  });
  writeFileSync(resolve(output, kind + '.metafile.json'), JSON.stringify(built.metafile, null, 2) + '\n');
}
writeFileSync(
  resolve(output, 'artifacts.json'),
  JSON.stringify(
    {
      status: 'PASS_LOCAL_BUNDLES',
      deployable: false,
      manifestIncluded: false,
      cloudCalls: 0,
      lockSha256: createHash('sha256')
        .update(readFileSync(resolve(root, 'pnpm-lock.yaml')))
        .digest('hex'),
      artifacts: records,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    status: 'PASS_LOCAL_BUNDLES',
    artifacts: records.map(({ kind, sha256, bytes }) => ({ kind, sha256, bytes })),
    deployments: 0,
  }) + '\n',
);
