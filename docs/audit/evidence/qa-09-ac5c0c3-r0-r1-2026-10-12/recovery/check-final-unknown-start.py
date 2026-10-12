"""Bind the original unknown Plan to the final exact inventory; absence is not proof."""
from pathlib import Path
import base64, hashlib, json

root = Path(__file__).resolve().parent.parent
out = root / 'restore/unknown-start-final-status.json'
assert not out.exists()
names = ['r0/sample.json.business-audit-2.json', 'r0/sample.json.business-audit-2.json.preparation.json', 'restore/owned-build-terminal-bounded.json']
bindings = {n: hashlib.sha256((root / n).read_bytes()).hexdigest() for n in names}
original, prep, inventory = [json.loads((root / n).read_text()) for n in names]
assert original['gate'] == 'FAIL' and original['failure']['kind'] == 'START_OUTCOME_UNCONFIRMED' and not original.get('build')
assert inventory['gate'] == 'PASS' and inventory['fullOriginalRunWindowCovered'] and inventory['allMatchingOwnBuildsTerminal']
env = {x['name']: x['value'] for x in prep['project']['environment']['environmentVariables']}
plan_hash = hashlib.sha256(base64.b64decode(env['QA09_FIXTURE_PLAN_B64'], validate=True)).hexdigest()
matches = [x for x in inventory['ownBuilds'] if x['planHash'] == plan_hash and x['fixtureSourceHash'] == prep['sourceHash'] and x['preparedBuildspecSha256'] == prep['buildspecHash']]
assert not matches, 'EXACT_ORIGINAL_PLAN_NOW_OBSERVED_REQUIRES_READ_ONLY_RESOLUTION'
result = dict(gate='PARTIAL', scope='ORIGINAL_UNKNOWN_READ_ONLY_START_PRESERVED_AFTER_FINAL_EXACT_INVENTORY', sourceCommit='ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2', prefix=prep['plan']['prefix'], action=prep['plan']['action'], originalGate='FAIL', originalStartGate='UNKNOWN', finalStartGate='UNKNOWN', exactMatchesInFinalBoundedWindow=0, originalStartResolved=False, absenceProvesNonExecution=False, knownBuildsTerminal=inventory['knownBuildCount'], restarts=0, writes=0, bindings=bindings)
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k: v for k, v in result.items() if k != 'bindings'}))
