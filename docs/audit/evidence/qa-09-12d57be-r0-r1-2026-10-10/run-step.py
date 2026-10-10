"""Run one exact, reviewed step once and preserve original process output/exit."""
import os, subprocess, sys, json, datetime
from pathlib import Path
root = Path(__file__).resolve().parent
mode, label, *args = sys.argv[1:]
assert mode in ['preflight', 'default-off', 'r0', 'r1', 'restore']
assert label and all(c.isalnum() or c in '-_' for c in label) and args
p = root / mode
with (p / (label + '.step.command.json')).open('x') as out:
    json.dump({'args': args, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}, out, indent=2)
    out.write('\n')
env = {**os.environ, 'PATH': '/Users/anray/.nvm/versions/node/v24.12.0/bin:' + os.environ['PATH']}
with (p / (label + '.step.stdout.log')).open('x') as out, (p / (label + '.step.stderr.log')).open('x') as err:
    result = subprocess.run(args, env=env, stdout=out, stderr=err)
(p / (label + '.step.exit')).write_text(str(result.returncode) + '\n')
print(json.dumps({'mode': mode, 'step': label, 'exitCode': result.returncode}), flush=True)
sys.exit(result.returncode)
