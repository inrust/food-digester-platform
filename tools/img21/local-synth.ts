/** Executable OFFLINE FIXTURE ONLY. Does not export a deploy action or call an AWS provider. */
import net from 'node:net';
import { App } from 'aws-cdk-lib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { canonical, digest, jsonHash, requireThat } from './contracts.js';
import { renderWriterManifest, renderVerifierManifest, manifestPairReceipt } from './manifests.js';
import { packageLambda } from './archive.js';
import { Img21ToolsStack, checkBudget } from './infra.js';
import type { ToolAsset } from './infra.js';
import { fixtureInput, FIXTURE_NOW } from './local-fixture.js';
import {
  reviewedControlPlanePatch,
  writerPolicy,
  verifierPolicy,
  writerBoundary,
  runtimeTrust,
  controlPlaneDelta,
} from './policies.js';
let networkAttempts = 0;
net.Socket.prototype.connect = function (): never {
  networkAttempts++;
  throw Error('OFFLINE_SYNTH_NETWORK_FORBIDDEN');
};
globalThis.fetch = async () => {
  networkAttempts++;
  throw Error('OFFLINE_SYNTH_NETWORK_FORBIDDEN');
};
const root = fileURLToPath(new URL('../../', import.meta.url)),
  out = resolve(root, 'build/img21-mc02');
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [resolve(root, 'tools/img21/build.mjs'), 'build/img21-mc02/code'], {
  cwd: root,
  stdio: 'pipe',
});
const source = JSON.parse(readFileSync(resolve(out, 'code/artifacts.json'), 'utf8'));
const f = fixtureInput(),
  writer = renderWriterManifest(f.manifest),
  verifier = renderVerifierManifest(writer, f.snapshot, FIXTURE_NOW);
const save = (name: string, value: unknown) => writeFileSync(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
const assets: Record<string, ToolAsset> = {};
for (const [kind, bound] of [
  ['writer', writer],
  ['verifier', verifier],
] as const) {
  const code = readFileSync(resolve(out, `code/${kind}.mjs`));
  requireThat(digest(code) === source.artifacts.find((a: any) => a.kind === kind).sha256, 'BUILT_CODE_DRIFT');
  const packed = packageLambda(code, bound),
    path = resolve(out, kind + '.zip');
  writeFileSync(path, packed.bytes);
  writeFileSync(resolve(out, kind + '-manifest.json'), canonical(bound.manifest));
  assets[kind] = { path, sha256: packed.sha256, codeSha256: packed.codeSha256, manifestHash: bound.hash };
}
const receipt = {
  runId: writer.manifest.runId,
  manifestHash: writer.hash,
  status: 'COMMITTED' as const,
  action: 'BIND_DEVICE' as const,
  operationId: 'd'.repeat(64),
  requestHash: 'f'.repeat(64),
  binding: f.snapshot.binding,
  sourceRef: 'LOCAL_FIXTURE_NOT_REAL_WRITER_RECEIPT',
};
for (const phase of ['A', 'B'] as const) {
  const app = new App({
    autoSynth: false,
    outdir: resolve(out, 'assembly-' + phase),
    context: { 'aws:cdk:enable-path-metadata': false, 'aws:cdk:enable-asset-metadata': false },
  });
  const stack = new Img21ToolsStack(app, 'Img21Tools', {
    stackName: 'fdp-test-img21-tools',
    analyticsReporting: false,
    writer,
    writerAsset: assets.writer!,
    phase,
    network: f.network,
    budget: f.budget,
    now: FIXTURE_NOW,
    ...(phase === 'B'
      ? {
          verifier,
          verifierAsset: assets.verifier!,
          deviceId: f.snapshot.binding.deviceId,
          bindingReceipt: receipt,
          previousWriterAssetSha256: assets.writer!.sha256,
        }
      : {}),
  });
  const template = app.synth().getStackArtifact(stack.artifactId).template;
  save('phase-' + phase + '-template.json', template);
}
for (const name of ['FDP-DeploymentBoundary', 'FDP-CloudFormationExecutionPolicy']) {
  const path = resolve(root, `infra/iam/${name}.json`),
    old = readFileSync(path);
  save(name + '-review-only.json', {
    originalPath: `infra/iam/${name}.json`,
    originalSha256: digest(old),
    proposed: reviewedControlPlanePatch(JSON.parse(old.toString())),
    applied: false,
  });
}
save('runtime-policies.json', {
  phaseA: writerPolicy('A'),
  phaseB: writerPolicy('B', f.snapshot.binding.deviceId),
  writerBoundary: writerBoundary(),
  verifier: verifierPolicy(),
  trust: runtimeTrust(),
  controlPlaneDelta: controlPlaneDelta(),
});
save('manifest-pair.json', manifestPairReceipt(writer, verifier, f.snapshot));
save('snapshot-fixture.json', f.snapshot);
save('assets.json', {
  mode: 'LOCAL_FIXTURE_ONLY',
  assets,
  bundleSourceManifestSha256: digest(readFileSync(resolve(out, 'code/artifacts.json'))),
  writerManifestHash: writer.hash,
  verifierManifestHash: verifier.hash,
  writerStableAcrossPhases: true,
});
save('result.json', {
  status: 'PASS_LOCAL_SYNTH_FIXTURE_ONLY',
  fixtureClock: new Date(FIXTURE_NOW).toISOString(),
  fixtureManifestContainsSyntheticCommit: true,
  budget: checkBudget(f.budget, FIXTURE_NOW),
  templateHashes: Object.fromEntries(
    ['A', 'B'].map((p) => [p, digest(readFileSync(resolve(out, 'phase-' + p + '-template.json')))]),
  ),
  assetHashes: Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, a.sha256])),
  manifestPairDigest: jsonHash([writer.hash, verifier.hash]),
  invokeGrantGenerated: false,
  deploymentReady: false,
  targetAdmission: 'BLOCKED_MISSING_REAL_INPUTS',
  networkAttempts,
  cloudCalls: 0,
  deployments: 0,
  iamChanges: 0,
  g4: 'NOT_RUN',
});
process.stdout.write(readFileSync(resolve(out, 'result.json')));
