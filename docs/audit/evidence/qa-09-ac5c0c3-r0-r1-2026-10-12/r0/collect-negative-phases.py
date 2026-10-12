"""Call the pushed repository collector through its isolated real CLI entry."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent;repo=root.parents[4]
args=['python3','-I',str(repo/'scripts/collect-qa09-auxiliary-phases.py'),str(root/'negative-get.json'),str(root/'negative-phases.json'),'--mode','negative','--expected-commit','ac5c0c335dc9356236e04f724b7abd5ccb8ef9f2']
if 'negative'=='initial':args+=['--parent',str(root/'sample.json.fixtures.json')]
sys.exit(subprocess.run(args,cwd=repo).returncode)
