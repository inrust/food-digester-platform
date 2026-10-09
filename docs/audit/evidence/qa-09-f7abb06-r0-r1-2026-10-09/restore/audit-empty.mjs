import { readFileSync, existsSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runFixture } from '../../../../../scripts/qa09-ten-device-bridge.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const restored = JSON.parse(readFileSync(join(dir, 'restore-completion.json')));
if (restored.gate !== 'PASS') throw Error('RESTORE_REQUIRED');
const predecessor = restored.scope.includes('R0_FAILED_STAGE') ? 'r0' : 'r1';
const child = JSON.parse(readFileSync(join(dir, `../${predecessor}/sample.json`)));
const parent = JSON.parse(readFileSync(join(dir, `../${predecessor}/`+(existsSync(join(dir,`../${predecessor}/sample.json.fixtures.effective.json`))?'sample.json.fixtures.effective.json':'sample.json.fixtures.json'))));
const recoveryPath=join(dir,`../${predecessor}/cleanup-recovery-completion.json`);
let cleanupReady=parent.gate==='PASS'&&child.cleanupComplete&&child.cleanup.every(c=>c.result==='PASS')&&parent.cleanup.every(c=>c.result==='PASS');
if(restored.scope.includes('R0_FAILED_STAGE')&&existsSync(recoveryPath)){
 const recovery=JSON.parse(readFileSync(recoveryPath)),hash=b=>createHash('sha256').update(b).digest('hex');
 cleanupReady=recovery.gate==='PASS'&&recovery.sourceCommit===child.sourceCommit&&recovery.prefix===child.prefix&&recovery.originalExecutionGate==='FAIL'&&recovery.independentEmptyAudit==='PASS'&&recovery.cleanup.every(c=>c.result==='PASS')&&recovery.bindings['sample.json']===hash(readFileSync(join(dir,'../r0/sample.json')))&&recovery.bindings['sample.json.fixtures.json']===hash(readFileSync(join(dir,'../r0/sample.json.fixtures.json')));
}
if (child.sourceCommit !== 'f7abb0670398a1254fcf45755f077b41f4fcd4c0' || child.prefix !== parent.prefix || !cleanupReady) throw Error('FINAL_OWN_CLEANUP_REQUIRED');
const first = parent.databaseBuilds.find(b => b.action === 'observe');
const initial = JSON.parse(readFileSync(first.receipt));
if (initial.gate !== 'PASS' || initial.result.prefix !== child.prefix || initial.result.action !== 'observe') throw Error('INITIAL_BASELINE_REQUIRED');
await runFixture({ prefix: child.prefix, devices: parent.devices, customers: parent.customers, action: 'audit-empty', baseline: initial.result.originalFingerprints }, join(dir, 'database-empty-audit.json'), p => console.log(p));
