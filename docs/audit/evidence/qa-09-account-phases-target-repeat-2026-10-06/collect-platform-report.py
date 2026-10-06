"""Read only the exact own PATCH invocation REPORT records; persist safe metrics."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
source = root / 'request-correlation.json'
raw = source.read_bytes()
receipt = json.loads(raw)
assert receipt['gate'] == 'PASS' and receipt['exactLinkedCount'] == 6
records = []
for row in receipt['records']:
    assert len(row['lambda']) == 1
    invocation = row['lambda'][0]['lambdaRequestId']
    assert re.fullmatch(r'[a-f0-9-]{36}', invocation)
    response = subprocess.run([
        'aws', 'logs', 'filter-log-events', '--log-group-name', '/aws/lambda/fdp-test-api',
        '--filter-pattern', '"' + invocation + '"',
        '--start-time', str(receipt['startMs']), '--end-time', str(receipt['endMs']),
        '--profile', 'esgiot-readonly',
        '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager',
    ], capture_output=True, text=True, timeout=45, check=True)
    matches = []
    for event in json.loads(response.stdout).get('events', []):
        message = event['message']
        if not re.search(r'REPORT RequestId:\s*' + re.escape(invocation) + r'\b', message):
            continue
        metrics = {}
        for label, key in [('Duration', 'durationMs'), ('Billed Duration', 'billedDurationMs'),
                           ('Memory Size', 'memoryMiB'), ('Max Memory Used', 'maxMemoryMiB'),
                           ('Init Duration', 'initDurationMs')]:
            found = re.search(r'(?:^|\t)' + label + r':\s*([0-9.]+)\s*(?:ms|MB)', message)
            if found:
                metrics[key] = float(found.group(1))
        matches.append({'timestampMs': event['timestamp'], **metrics})
    assert len(matches) == 1, 'EXACT_PLATFORM_REPORT_REQUIRED'
    records.append({'requestId': row['requestId'], 'lambdaRequestId': invocation,
                    'status': row['status'], **matches[0]})
result = {'gate': 'PASS', 'scope': 'EXACT_OWN_PATCH_LAMBDA_REPORT',
          'sourceReceiptSha256': hashlib.sha256(raw).hexdigest(),
          'collectorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'records': records, 'p95Accepted': False}
(root / 'platform-report.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS exact REPORT records:', len(records))
