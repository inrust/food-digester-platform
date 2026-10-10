"""One bounded new-prefix unit; the reviewed runner owns cleanup in finally."""
import subprocess,json,datetime,sys
from pathlib import Path
p=Path(sys.argv[1]);sha='12d57befe55be1e1abfd1e226c2d13cbace992dc'
receipt=json.loads((p/'deployment-input-binding.json').read_text());version=json.loads((p/'application-version.json').read_text())
assert receipt['gate']=='PASS' and version['gate']=='PASS' and version['sourceCommit']==sha and len(version['lambdaArtifacts'])==19
assert not (p/'sample.json').exists(),'NO_REPLAY_EXISTING_UNIT'
args=['node','--import','tsx','scripts/run-qa09-nonactive-target.mjs',str(p/'sample.json'),str(p/'application-version.json'),'--cold409-sampling']
(p/'business-command.json').write_text(json.dumps(args,indent=2)+'\n')
window={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':sha,'runId':receipt['runId']}
(p/'business-window.json').write_text(json.dumps(window,indent=2)+'\n')
with (p/'business.stdout.log').open('w') as out,(p/'business.stderr.log').open('w') as err:
 code=subprocess.run(args,stdout=out,stderr=err).returncode
(p/'business.exit').write_text(str(code)+'\n')
window['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();window['exitCode']=code
(p/'business-window.json').write_text(json.dumps(window,indent=2)+'\n');print(json.dumps(window))
sys.exit(code)
