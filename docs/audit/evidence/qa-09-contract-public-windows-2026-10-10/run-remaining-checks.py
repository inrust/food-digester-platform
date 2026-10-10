"""Repository checks only; this script never dispatches AWS or target business work."""
from pathlib import Path
import json, os, subprocess, time

root = Path(__file__).resolve().parent
repo = root.parents[3]
env = dict(os.environ)
env['PATH'] = '/Users/anray/.nvm/versions/node/v24.12.0/bin:' + env['PATH']
steps = [
    ('focused-app', ['pnpm','exec','vitest','run','packages/database/test/contract-windows-offline.test.ts','packages/database/test/contract-window-probe.test.ts','packages/database/test/contract-load-detail.test.ts']),
    ('focused-scripts',['node','--test','scripts/qa09-contract-windows-proof.test.mjs']),
    ('lint', ['pnpm', 'exec', 'eslint', '.', '--ignore-pattern', 'build/']),
    ('format', ['pnpm', 'exec', 'prettier', '--check', '.', '!build/**']),
]
steps += [(name.replace(':', '-'), ['pnpm', name]) for name in [
    'typecheck', 'openapi:check', 'test', 'build', 'check:boundaries',
    'check:schemas', 'check:migrations', 'check:evidence', 'check:secrets',
    'check:sensitive-sinks', 'check:admin-web-delivery', 'check:admin-web-e2e',
    'check:cmd-ota-delivery',
]]
steps += [(name.replace(':', '-'), ['pnpm', name, '/tmp/fdp-public-windows-' + name.replace(':', '-') + '.json']) for name in [
    'test:device-contracts', 'test:iot-integration', 'test:core-api-integration',
    'test:admin-e2e-suite', 'test:security-suite', 'test:reliability-suite', 'test:prototype-regression',
]]
steps = [('test-scripts-loopback', ['pnpm','test:scripts'])] + steps[next(i for i,v in enumerate(steps) if v[0]=='build'):]
assert not (root / 'remaining-checks.json').exists()
results = []
for name, args in steps:
    assert not (root / (name + '.command.json')).exists()
    (root / (name + '.command.json')).write_text(json.dumps({'args': args, 'scope': 'LOCAL_ONLY'}, indent=2) + '\n')
    started = time.monotonic()
    with (root / (name + '.stdout.log')).open('w') as out, (root / (name + '.stderr.log')).open('w') as err:
        run = subprocess.run(args, cwd=repo, env=env, stdout=out, stderr=err)
    row = {'name': name, 'exitCode': run.returncode, 'durationSeconds': round(time.monotonic()-started, 3)}
    results.append(row)
    (root / (name + '.exit')).write_text(str(run.returncode) + '\n')
    print(json.dumps(row), flush=True)
    if run.returncode:
        (root / 'remaining-checks.json').write_text(json.dumps({'gate': 'FAIL', 'results': results}, indent=2) + '\n')
        raise SystemExit(run.returncode)
(root / 'remaining-checks.json').write_text(json.dumps({
    'gate': 'PASS', 'scope': 'REMAINING_VERIFY_LOCAL_LOOPBACK_ONLY', 'results': results,
    'exception': 'Unrelated user-owned untracked build/ excluded from eslint and prettier only; no other verify step omitted.',
    'targetGate': 'NOT_RUN', 'p95Accepted': False,
}, indent=2) + '\n')
