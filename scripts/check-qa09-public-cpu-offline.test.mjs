import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyBindings } from './check-qa09-public-cpu-offline.mjs';
test('seal rejects changed bytes and traversal before resolving file paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa09-offline-seal-'));
  try {
    writeFileSync(join(root, 'receipt.json'), '{}');
    const digest = createHash('sha256').update('{}').digest('hex');
    assert.doesNotThrow(() => verifyBindings(root, { 'receipt.json': digest }));
    writeFileSync(join(root, 'receipt.json'), '{"accepted":true}');
    assert.throws(() => verifyBindings(root, { 'receipt.json': digest }), /OFFLINE_BINDING:/);
    assert.throws(() => verifyBindings(root, { '../other': digest }), /OFFLINE_BINDING_PATH/);
    assert.throws(() => verifyBindings(root, { '/other': digest }), /OFFLINE_BINDING_PATH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
