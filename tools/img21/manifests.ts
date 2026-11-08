import { bindManifest, canonical, digest, exactKeys, isHash, isUuid, requireThat } from './contracts.js';
import type { Binding, BoundManifest, Manifest } from './contracts.js';
export interface Snapshot {
  observedAt: string;
  sourceRef: string;
  binding: Binding;
  licenseId: string;
  licenseVersion: number;
  snapshotEtag: string;
}
export function renderWriterManifest(input: Manifest): BoundManifest {
  requireThat(input.verifierBinding === null && input.verification === null, 'WRITER_MANIFEST_MUST_STAY_UNBOUND');
  const raw = canonical({ ...input, writerVersion: 'PUBLISHED', verifierVersion: 'PUBLISHED' });
  return bindManifest(raw, digest(raw));
}
export function renderVerifierManifest(writer: BoundManifest, snapshot: Snapshot, now: number): BoundManifest {
  exactKeys(snapshot, ['observedAt', 'sourceRef', 'binding', 'licenseId', 'licenseVersion', 'snapshotEtag']);
  const m = writer.manifest;
  requireThat(
    m.writerVersion === 'PUBLISHED' && m.verification === null && m.verifierBinding === null,
    'FIXED_WRITER_MANIFEST_REQUIRED',
  );
  const observed = Date.parse(snapshot.observedAt),
    end = Date.parse(m.window.endsAt);
  requireThat(
    Number.isFinite(observed) &&
      new Date(observed).toISOString() === snapshot.observedAt &&
      Date.parse(m.window.startsAt) <= observed &&
      observed <= now &&
      now < Math.min(observed + 300000, end),
    'SNAPSHOT_STALE_OR_FUTURE',
  );
  requireThat(
    typeof snapshot.sourceRef === 'string' &&
      snapshot.sourceRef.length > 0 &&
      snapshot.sourceRef.length <= 200 &&
      isUuid(snapshot.licenseId) &&
      Number.isSafeInteger(snapshot.licenseVersion) &&
      snapshot.licenseVersion > 0 &&
      isHash(snapshot.snapshotEtag),
    'CURRENT_SNAPSHOT_REQUIRED',
  );
  const raw = canonical({
    ...m,
    verifierBinding: snapshot.binding,
    verification: {
      licenseId: snapshot.licenseId,
      licenseVersion: snapshot.licenseVersion,
      snapshotEtag: snapshot.snapshotEtag,
      observedAt: snapshot.observedAt,
      expiresAt: new Date(Math.min(observed + 300000, end)).toISOString(),
    },
  });
  return bindManifest(raw, digest(raw));
}
export function validateManifestPair(writer: BoundManifest, verifier: BoundManifest) {
  const { verifierBinding: _b, verification: _v, ...stable } = verifier.manifest;
  const raw = canonical({ ...stable, verifierBinding: null, verification: null });
  requireThat(
    digest(raw) === writer.hash &&
      verifier.hash !== writer.hash &&
      verifier.manifest.verifierBinding &&
      verifier.manifest.verification?.observedAt,
    'MANIFEST_PAIR_MISMATCH',
  );
}

export function manifestPairReceipt(writer: BoundManifest, verifier: BoundManifest, snapshot: Snapshot) {
  validateManifestPair(writer, verifier);
  const rebuilt = renderVerifierManifest(writer, snapshot, Date.parse(snapshot.observedAt));
  requireThat(rebuilt.hash === verifier.hash, 'SNAPSHOT_RENDERING_MISMATCH');
  return {
    writerManifestHash: writer.hash,
    verifierManifestHash: verifier.hash,
    snapshotProofHash: digest(canonical(snapshot)),
    snapshotSourceRef: snapshot.sourceRef,
    observedAt: snapshot.observedAt,
    expiresAt: verifier.manifest.verification!.expiresAt,
  };
}
