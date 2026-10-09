import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root='docs/audit/evidence/qa-09-contract-await-offline-2026-10-10';
const temp=mkdtempSync(join(tmpdir(),'qa09-verify-'));
const ignore=readFileSync('.prettierignore','utf8')+'\n# Exclude pre-existing user untracked build artifacts\nbuild/\n';
writeFileSync(join(temp,'prettierignore'),ignore);
const commands=[['exec','eslint','.','--ignore-pattern','build/**'],['exec','prettier','--check','.','!build/**'],...JSON.parse(readFileSync('package.json')).scripts.verify.split(' && ').slice(2).map(s=>s.split(' ').slice(1))];
const receipt={scope:'FULL_VERIFY_EQUIVALENT_EXCEPT_UNRELATED_UNTRACKED_BUILD_LINT_FORMAT',excluded:'build/',originalVerify:'verify-initial.log',prettierIgnore:ignore,commands:[],gate:'RUNNING'};
try{
 for(const args of commands){console.log(JSON.stringify({command:['pnpm',...args]}));const child=spawnSync('pnpm',args,{stdio:'inherit',timeout:1800000});receipt.commands.push({command:['pnpm',...args],exit:child.status??-1});if(child.status!==0)throw Error('CHECK_FAILED');}
 receipt.gate='PASS';
}catch(e){receipt.gate='FAIL';process.exitCode=1;console.log(e.message);}finally{writeFileSync(root+'/verify-scoped-final.json',JSON.stringify(receipt,null,2)+'\n');rmSync(temp,{recursive:true,force:true});}
