import { runtimeManifest } from './runtime.js';
import { createLicenseVerifier, validateLicenseEvent } from './license-verifier.js';
import { createSecretPort } from './secret-port.js';
import type { Invocation } from './contracts.js';
export async function handler(event: unknown, context: Invocation) {
  try {
    const bound = runtimeManifest(process.env);
    validateLicenseEvent(bound, event, context, Date.now());
    return await createLicenseVerifier(bound, {
      now: Date.now,
      loadSecret: createSecretPort(bound.manifest.licenseSecretVersion),
    })(event, context);
  } catch {
    return { status: 'REJECTED', code: 'LICENSE_VERIFIER_UNAVAILABLE', keyExported: false };
  }
}
