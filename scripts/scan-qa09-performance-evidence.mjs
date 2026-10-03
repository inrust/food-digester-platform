import { readdirSync, readFileSync } from 'node:fs';
import { scanContent } from './check-secrets.mjs';
const root = 'docs/audit/evidence';
const files = readdirSync(root).filter((p) =>
  /^qa-09-(performance|slo|telemetry-api|admin-access).*2026-10-03.*\.json$/.test(p),
);
const findings = [];
let decodedSources = 0;
function inspect(text, file, path) {
  for (const f of scanContent(text)) findings.push({ file, path, rule: f.id });
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/.test(text))
    findings.push({ file, path, rule: 'raw-jwt' });
}
function visit(value, file, path = '$', key = '') {
  if (typeof value === 'string') {
    inspect(value, file, path);
    if (['sourceBase64', 'handlerSourceBase64'].includes(key)) {
      decodedSources++;
      inspect(Buffer.from(value, 'base64').toString('utf8'), file, path + '.decoded');
    }
  } else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) visit(v, file, path + '.' + k, k);
}
for (const file of files) {
  const text = readFileSync(root + '/' + file, 'utf8');
  inspect(text, file, '$raw');
  visit(JSON.parse(text), file);
}
console.log(JSON.stringify({ gate: findings.length ? 'FAIL' : 'PASS', files: files.length, decodedSources, findings }));
process.exitCode = findings.length ? 1 : 0;
