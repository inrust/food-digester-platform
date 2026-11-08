import { readFileSync } from 'node:fs';
import { bindManifest, requireThat, TARGET } from './contracts.js';
export function runtimeManifest(env: NodeJS.ProcessEnv) {
  requireThat(
    env.AWS_REGION === TARGET.region && typeof env.IMG21_MANIFEST_SHA256 === 'string',
    'TRUSTED_RUNTIME_REQUIRED',
  );
  // The only manifest source is part of the published Lambda asset, never a caller path/URL/event.
  return bindManifest(readFileSync('/var/task/run-manifest.json', 'utf8'), env.IMG21_MANIFEST_SHA256);
}
