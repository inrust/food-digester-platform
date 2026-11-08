import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAjv } from '../../../../../contracts/testing/device-contract.ts';
const base = new URL('../', import.meta.url);
const api = JSON.parse(fs.readFileSync(new URL('../../../../../contracts/rest/openapi.bundle.json', import.meta.url)));
const requests = JSON.parse(fs.readFileSync(new URL('http-write-intents.json', base))).requests;
const rows = [];
for (const row of requests) {
  const operation = api.paths[row.path][row.method.toLowerCase()];
  if (operation.operationId !== row.operationId) throw Error('OPERATION_DRIFT');
  if (!operation.requestBody) {
    if (row.body !== null) throw Error('BODY_MUST_BE_ABSENT');
    rows.push({ operationId: row.operationId, status: 'PASS_NO_BODY' });
    continue;
  }
  let body = operation.requestBody;
  if (body.$ref) body = body.$ref.slice(2).split('/').reduce((value, key) => value[key], api);
  const validate = createAjv().compile({ ...body.content['application/json'].schema, components: api.components });
  if (!validate(row.body)) throw Error(JSON.stringify(validate.errors));
  rows.push({ operationId: row.operationId, status: 'PASS_SCHEMA_ONLY_NOT_TARGET_EXECUTED' });
}
fs.writeFileSync(new URL('request-schema-check.json', base), JSON.stringify({ status: 'PASS', checks: rows, cloudWrites: 0 }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: 'PASS', requests: rows.length, script: fileURLToPath(import.meta.url) }) + '\n');
