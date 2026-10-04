import base64
import datetime
import gzip
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).parent
findings, visited = [], set()
counts = {'filesScanned': 0, 'decodedFields': 0, 'embeddedJson': 0}
patterns = {
    'aws-key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    'github-token': r'\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b',
    'jwt': r'\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\b',
    'presigned-url': r'https?://[^\s"<>]+[?&]X-Amz-Signature=[A-Fa-f0-9]{64}',
    'random-test-password': r'A!z9[A-Za-z0-9_-]{25,}',
}


def scan(text, path, depth=0):
    if depth > 12:
        raise ValueError('SCAN_DEPTH_EXCEEDED')
    digest = hashlib.sha256(text.encode()).hexdigest()
    if digest in visited:
        return
    visited.add(digest)
    for label, pattern in patterns.items():
        if re.search(pattern, text):
            findings.append({'path': path, 'pattern': label})
    for candidate in re.findall(r'H4s[A-Za-z0-9+/=]{100,}', text):
        decode(candidate, path + ':embedded-gzip', depth)
    try:
        walk(json.loads(text), path, depth + 1)
        counts['embeddedJson'] += 1
    except json.JSONDecodeError:
        pass


def decode(value, path, depth):
    try:
        raw = base64.b64decode(value, validate=True)
        if raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        decoded = raw.decode('utf8')
    except (ValueError, UnicodeDecodeError, OSError):
        return
    counts['decodedFields'] += 1
    scan(decoded, path, depth + 1)


def walk(value, path, depth):
    if isinstance(value, dict):
        for key, child in value.items():
            walk(child, path + ':' + key, depth)
        events = value.get('events')
        if isinstance(events, list):
            pending = ''
            for event in events:
                message = event.get('message', '') if isinstance(event, dict) else ''
                if message.startswith('{"kind":"fdp-qa09-ten-device-db/'):
                    pending = message
                elif pending:
                    pending += message
                else:
                    continue
                try:
                    frame = json.loads(pending)
                except json.JSONDecodeError:
                    continue
                walk(frame, path + ':reassembled-frame', depth + 1)
                pending = ''
    elif isinstance(value, list):
        for i, child in enumerate(value):
            walk(child, path + ':' + str(i), depth)
    elif isinstance(value, str):
        scan(value, path, depth)
        if len(value) >= 80 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', value):
            decode(value, path + ':base64', depth)


for file in root.rglob('*'):
    if not file.is_file() or file.name == 'full-evidence-secret-scan.json' or file.suffix.lower() in {'.png', '.jpg', '.zip', '.gz'}:
        continue
    counts['filesScanned'] += 1
    scan(file.read_text(errors='replace'), str(file))
receipt = {
    'scope': 'ALL_EVIDENCE_TEXT_WITHOUT_SIZE_SKIP_AND_BASE64_GZIP_ENV_PLANS_REASSEMBLED_FRAMES',
    'executorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    **counts,
    'findings': findings,
    'gate': 'PASS' if not findings else 'FAIL',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(root / 'full-evidence-secret-scan.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
raise SystemExit(0 if not findings else 1)
