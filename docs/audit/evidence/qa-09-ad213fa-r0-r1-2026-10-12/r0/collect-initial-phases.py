"""Call the pushed repository collector through its isolated real CLI entry."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent;repo=root.parents[4]
args=['python3','-I',str(repo/'scripts/collect-qa09-auxiliary-phases.py'),str(root/'sample.json'),str(root/'initial-phases.json'),'--mode','initial','--expected-commit','ad213fa27375369fc0320f1747b1490a6292a41b']
if 'initial'=='initial':args+=['--parent',str(root/'sample.json.fixtures.json')]
sys.exit(subprocess.run(args,cwd=repo).returncode)
