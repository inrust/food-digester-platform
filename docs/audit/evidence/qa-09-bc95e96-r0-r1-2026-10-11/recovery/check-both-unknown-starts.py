"""Relate both original unknown Plans to final bounded inventory; absence is not nonexecution."""
from pathlib import Path
import base64,hashlib,json
root=Path(__file__).resolve().parent.parent;out=root/'restore/unknown-starts-final-status.json';assert not out.exists()
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
inventory=json.loads((root/'restore/owned-build-terminal-bounded.json').read_text())
assert inventory['gate']=='PASS' and inventory['fullOriginalRunWindowCovered'] and inventory['allMatchingOwnBuildsTerminal']
names=['r0/sample.json.business-audit-2.json','restore/capacity-before.json'];rows=[];bindings={'restore/owned-build-terminal-bounded.json':digest(root/'restore/owned-build-terminal-bounded.json')}
for n in names:
 p=root/n;v=json.loads(p.read_text());prep=json.loads(Path(str(p)+'.preparation.json').read_text())
 assert v['gate']=='FAIL' and v['failure']['kind']=='START_OUTCOME_UNCONFIRMED' and not v.get('build')
 env={x['name']:x['value'] for x in prep['project']['environment']['environmentVariables']}
 planHash=hashlib.sha256(base64.b64decode(env['QA09_FIXTURE_PLAN_B64'],validate=True)).hexdigest()
 exact=[x for x in inventory['ownBuilds'] if x['planHash']==planHash and x['fixtureSourceHash']==prep['sourceHash'] and x['preparedBuildspecSha256']==prep['buildspecHash']]
 assert not exact
 rows.append(dict(receipt=n,action=prep['plan']['action'],prefix=prep['plan']['prefix'],originalGate='UNKNOWN',finalGate='UNKNOWN',exactMatchesInFinalBoundedWindow=0,absenceProvesNonExecution=False,restarts=0))
 bindings[n]=digest(p);bindings[n+'.preparation.json']=digest(Path(str(p)+'.preparation.json'))
out.write_text(json.dumps(dict(gate='PARTIAL',scope='TWO_ORIGINAL_UNKNOWN_STARTS_PRESERVED_AFTER_FINAL_EXACT_WINDOW_READ',unknownStarts=rows,knownBuildsTerminal=inventory['knownBuildCount'],originalStartsResolved=False,writes=0,bindings=bindings),indent=2)+'\n')
print(json.dumps(dict(gate='PARTIAL',unknownStarts=2,knownBuildsTerminal=inventory['knownBuildCount'],writes=0)))
