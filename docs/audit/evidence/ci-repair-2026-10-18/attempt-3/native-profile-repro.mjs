import { writeFileSync } from 'node:fs';
import { CpuProbe } from '../../../../../packages/database/test/helpers/contract-cpu-probe.ts';
import { cpuCases, validateCpuProfile } from '../../../../../scripts/qa09-contract-cpu-proof.mjs';

const observations = [];
for (let iteration = 0; iteration < 100; iteration++) {
  const probe = new CpuProbe(cpuCases['profile-on']);
  try {
    await probe.start();
    const end = performance.now() + 15;
    while (performance.now() < end) JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ value: i })));
    const profile = await probe.stop();
    const ids = new Set(profile.nodes.map((n) => n.id));
    const negativeDeltas = profile.timeDeltas.flatMap((delta, index) => delta < 0 ? [{ index, delta }] : []);
    const missingNodes = profile.samples.flatMap((id, index) => ids.has(id) ? [] : [{ index, id }]);
    let validation = 'PASS';
    try { validateCpuProfile(profile); } catch (error) { validation = error.message; }
    observations.push({ iteration, samples: profile.samples.length, negativeDeltas, missingNodes, validation });
    if (negativeDeltas.length || missingNodes.length) {
      writeFileSync(new URL('native-anomaly-profile.json', import.meta.url), JSON.stringify(profile, null, 2) + '\n');
      break;
    }
  } finally {
    await probe.close();
  }
}
writeFileSync(new URL('native-profile-repro.json', import.meta.url), JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  scope: 'BOUNDED_NATIVE_INSPECTOR_DIAGNOSTIC_ONLY', observations,
}, null, 2) + '\n');
console.log(JSON.stringify(observations.at(-1)));
