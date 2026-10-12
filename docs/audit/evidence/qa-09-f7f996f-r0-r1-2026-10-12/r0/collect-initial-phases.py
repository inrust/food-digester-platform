"""Call the pushed repository collector through its isolated real CLI entry."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent;repo=root.parents[4]
args=['python3','-I',str(repo/'scripts/collect-qa09-auxiliary-phases.py'),str(root/'sample.json'),str(root/'initial-phases.json'),'--mode','initial','--expected-commit','f7f996f278877cb57fc9d400f8f1d24b6ff5ff48']
if 'initial'=='initial':args+=['--parent',str(root/'sample.json.fixtures.json')]
sys.exit(subprocess.run(args,cwd=repo).returncode)
