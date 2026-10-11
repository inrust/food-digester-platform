"""Run the repository's exact 22 local gates serially, retaining each original result."""
import datetime
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path(__file__).resolve().parent
root.mkdir(parents=True, exist_ok=True)
commands = json.loads(Path('package.json').read_text())['scripts']['verify'].split(' && ')
assert len(commands) == 22
assert not (root / 'verify-results.json').exists(), 'FRESH_VERIFY_RECEIPT_REQUIRED'
rows = []
for i, command in enumerate(commands, 1):
    log = root / ('verify-%02d.log' % i)
    assert not log.exists(), 'FRESH_VERIFY_LOG_REQUIRED'
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    before = time.monotonic()
    with log.open('w') as output:
        try:
            q = subprocess.run(shlex.split(command), stdout=output, stderr=subprocess.STDOUT,
                               timeout=600, env=os.environ.copy())
            code = q.returncode
        except subprocess.TimeoutExpired:
            code = -1
    rows.append({'original': command, 'log': log.name, 'startedAt': started,
                 'durationMs': round((time.monotonic() - before) * 1000), 'exitCode': code})
    (root / 'verify-results.json').write_text(json.dumps({'commands': rows, 'noCloudActions': True,
        'gate': 'PASS' if len(rows) == 22 and all(r['exitCode'] == 0 for r in rows) else 'PARTIAL'}, indent=2) + '\n')
    print(i, code, command, flush=True)
    if code:
        raise SystemExit(code)
