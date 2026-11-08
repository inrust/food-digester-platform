/** Minimal deterministic ZIP_STORED, two regular files only. No symlinks or shell zip metadata. */
import { digest, requireThat } from './contracts.js';
import type { BoundManifest } from './contracts.js';
import { canonical } from './contracts.js';
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const n of b) {
    c ^= n;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
export function packageLambda(code: Buffer, bound: BoundManifest) {
  const manifest = Buffer.from(canonical(bound.manifest));
  requireThat(digest(manifest) === bound.hash, 'CANONICAL_MANIFEST_REQUIRED');
  const files = [
    ['index.mjs', code],
    ['run-manifest.json', manifest],
  ] as const;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of files) {
    const n = Buffer.from(name),
      crc = crc32(body),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    local.push(h, n, body);
    central.push(c, n);
    offset += h.length + n.length + body.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, cd, end]);
  return {
    bytes,
    sha256: digest(bytes),
    codeSha256: Buffer.from(digest(bytes), 'hex').toString('base64'),
    manifestHash: bound.hash,
  };
}

export function verifyLambdaPackage(bytes: Buffer, bound: BoundManifest) {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    requireThat(bytes.readUInt16LE(offset + 8) === 0 && bytes.readUInt16LE(offset + 28) === 0, 'ZIP_STORED_ONLY');
    const size = bytes.readUInt32LE(offset + 18),
      len = bytes.readUInt16LE(offset + 26),
      name = bytes.subarray(offset + 30, offset + 30 + len).toString();
    requireThat(
      ['index.mjs', 'run-manifest.json'].includes(name) && !files.has(name) && offset + 30 + len + size <= bytes.length,
      'ZIP_ENTRY_REJECTED',
    );
    const body = bytes.subarray(offset + 30 + len, offset + 30 + len + size);
    requireThat(crc32(body) === bytes.readUInt32LE(offset + 14), 'ZIP_CRC_MISMATCH');
    files.set(name, body);
    offset += 30 + len + size;
  }
  requireThat(files.size === 2 && digest(files.get('run-manifest.json')!) === bound.hash, 'ZIP_MANIFEST_MISMATCH');
  requireThat(packageLambda(files.get('index.mjs')!, bound).bytes.equals(bytes), 'NONCANONICAL_ZIP');
  return { entrySha256: digest(files.get('index.mjs')!), manifestHash: bound.hash };
}
