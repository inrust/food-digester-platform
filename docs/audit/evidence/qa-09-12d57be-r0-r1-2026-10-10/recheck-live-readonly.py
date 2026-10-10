"""Final read-only snapshot of existing runs and API revision; never dispatches work."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json, os, subprocess

root = Path(__file__).resolve().parent
out = root / 'final-live-readonly.json'
assert not out.exists()
sha = '12d57befe55be1e1abfd1e226c2d13cbace992dc'
env = {**os.environ, 'AWS_MAX_ATTEMPTS': '1'}
runs = ['38048245435', '38048245357'] + [str(json.loads((root / mode / 'dispatch-run.json').read_text())['databaseId']) for mode in ['r0','r1','restore']]
def read_run(run):
    args = ['gh', 'run', 'view', run, '--repo', 'inrust/food-digester-platform', '--json', 'databaseId,headSha,status,conclusion,url,updatedAt']
    q = subprocess.run(args, capture_output=True, timeout=30, env=env)
    assert q.returncode == 0, 'GITHUB_READ_FAILED:' + run
    v = json.loads(q.stdout)
    assert v['headSha'] == sha and v['status'] == 'completed' and v['conclusion'] == 'success', 'RUN_SOURCE_OR_STATUS_DRIFT'
    return v
with ThreadPoolExecutor(max_workers=3) as pool:
    records = list(pool.map(read_run, runs))
query = '{name:FunctionName,revisionId:RevisionId,codeSha256:CodeSha256,state:State,update:LastUpdateStatus,preconnect:Environment.Variables.FDP_QA09_AUTHENTICATED_PRECONNECT,accountReadCandidate:Environment.Variables.FDP_QA09_ACCOUNT_READ_CANDIDATE,contractLoadDetail:Environment.Variables.FDP_QA09_CONTRACT_LOAD_DETAIL,contractPublicBoundaries:Environment.Variables.FDP_QA09_CONTRACT_PUBLIC_BOUNDARIES}'
args = ['aws', 'lambda', 'get-function-configuration', '--function-name', 'fdp-test-api', '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '10', '--query', query]
q = subprocess.run(args, capture_output=True, timeout=30, env=env)
assert q.returncode == 0, 'AWS_READ_FAILED'
api = json.loads(q.stdout)
prior = json.loads((root / 'restore/actual-config.json').read_text())['config']
assert api['revisionId'] == prior['revisionId'] and api['codeSha256'] == prior['codeSha256'], 'API_REVISION_DRIFT'
assert api['state'] == 'Active' and api['update'] == 'Successful'
assert all(api[k] == 'false' for k in ['preconnect', 'accountReadCandidate', 'contractLoadDetail', 'contractPublicBoundaries'])
result = {'gate': 'PASS', 'scope': 'EXISTING_RUN_STATUS_AND_FINAL_API_REVISION_READ_ONLY', 'sourceCommit': sha,
          'checkedAt': datetime.now(timezone.utc).isoformat(), 'runs': records, 'api': api,
          'newDeployments': 0, 'newBuilds': 0, 'newBusinessRequests': 0, 'p95Accepted': False, 'fullQa09Accepted': False}
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'gate': 'PASS', 'existingRuns': len(records), 'apiRevisionUnchanged': True, 'actualSwitchesFalse': 4}))
