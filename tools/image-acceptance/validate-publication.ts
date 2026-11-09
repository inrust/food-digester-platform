/** Pure artifact validation child; stdin/stdout only. Never calls the read-only AWS observer. */
import { createHash } from 'node:crypto';
import { bindManifest, jsonHash, requireThat } from '../img21/contracts.js';
import { verifyLambdaPackage } from '../img21/archive.js';
import { validatePublished } from '../img21/publication.js';
import { writerPolicy, writerBoundary, verifierPolicy } from '../img21/policies.js';
let text = '';
for await (const part of process.stdin) {
  text += part;
  requireThat(Buffer.byteLength(text) <= 32 * 1024 * 1024, 'ARTIFACT_SIZE_LIMIT');
}
try {
  const input = JSON.parse(text),
    bound = bindManifest(input.manifest, input.manifestHash),
    bytes = Buffer.from(input.zipBase64, 'base64');
  requireThat(
    bound.manifest.toolCommit === input.toolSourceCommit &&
      bound.manifest.applicationCommit === input.applicationCandidate,
    'TOOL_MANIFEST_SOURCE_MISMATCH',
  );
  const info = verifyLambdaPackage(bytes, bound);
  requireThat(info.entrySha256 === input.bareEntrySha256, 'FROZEN_TOOL_ENTRY_MISMATCH');
  const sha256 = createHash('sha256').update(bytes).digest('hex'),
    isWriter = input.id === 'writer';
  requireThat(input.id === 'writer' || input.id === 'verifier', 'TOOL_KIND');
  const ticket = validatePublished(
    {
      kind: input.id,
      bound,
      asset: {
        path: 'MEMORY.zip',
        sha256,
        codeSha256: Buffer.from(sha256, 'hex').toString('base64'),
        manifestHash: bound.hash,
      },
      policy: isWriter ? writerPolicy('B', input.deviceId) : verifierPolicy(),
      boundary: isWriter ? writerBoundary() : verifierPolicy(),
      network: input.network,
    },
    input.publication,
    Date.parse(input.publication.capturedAt),
  );
  // G4 current source observation may follow the five-minute verification. It is NOT a new Invoke authorization.
  const stable = (o: any) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !['capturedAt', 'principalArn'].includes(k)));
  requireThat(
    jsonHash(stable(input.current)) === jsonHash(stable(input.publication)),
    'TOOL_CURRENT_SOURCE_OR_POLICY_DRIFT',
  );
  requireThat(
    bound.manifest.approvalRef === input.preparationWindow.authorizationRef &&
      bound.manifest.window.startsAt === input.preparationWindow.startsAt &&
      bound.manifest.window.endsAt === input.preparationWindow.endsAt,
    'TOOL_PREPARATION_AUTHORIZATION_DRIFT',
  );
  const t = Date.parse(input.publication.capturedAt);
  requireThat(
    Date.parse(input.preparationWindow.startsAt) <= t && t <= Date.parse(input.preparationWindow.endsAt),
    'TOOL_PUBLICATION_OUTSIDE_PREPARATION',
  );
  process.stdout.write(
    JSON.stringify({
      status: 'PASS_SOURCE_BINDING_ONLY',
      ticket,
      observationHash: jsonHash(input.current),
      g4: 'NOT_RUN',
      cloudCalls: 0,
    }),
  );
} catch {
  process.stdout.write(
    JSON.stringify({ status: 'FAIL', code: 'TOOL_SOURCE_PUBLICATION_NOT_PROVEN', g4: 'NOT_RUN', cloudCalls: 0 }),
  );
  process.exitCode = 1;
}
