"""Bounded read-only CloudWatch pagination shared by normal and exact collection."""
import json
import math
import os
import re
import subprocess
import time

TOTAL_SECONDS = 120
CALL_SECONDS = 15
MAX_CALLS = 40
MAX_QUERY_PAGES = 20
EXACT_BATCH_SIZE = 3


def safe_cli_error(stderr):
    text = stderr or ''
    if re.search(r'AccessDenied|UnauthorizedOperation', text, re.I):
        return 'LOG_ACCESS_DENIED'
    if re.search(r'Token has expired|refresh failed|SSO.*expired|UnauthorizedException', text, re.I):
        return 'LOG_SSO_EXPIRED'
    if re.search(r'Throttl|TooManyRequests|RequestLimitExceeded', text, re.I):
        return 'LOG_THROTTLED'
    return 'LOG_READ_FAILED'


class LogReader:
    def __init__(self):
        self.started = time.monotonic()
        self.deadline = self.started + TOTAL_SECONDS
        self.attempts = []
        self.group_errors = {}
        self.error = None

    def fail(self, group, error):
        self.group_errors[group] = error
        self.error = self.error or error

    def pages(self, name, group, start_ms, end_ms, pattern=None, query=0):
        if self.error:
            self.group_errors[name] = self.group_errors.get(name, 'LOG_READ_NOT_STARTED')
            return
        token, seen = None, set()
        for page_number in range(1, MAX_QUERY_PAGES + 1):
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                self.fail(name, 'LOG_TOTAL_DEADLINE_EXCEEDED')
                return
            if len(self.attempts) >= MAX_CALLS:
                self.fail(name, 'LOG_CALL_LIMIT')
                return
            timeout = min(CALL_SECONDS, remaining)
            args = ['aws', 'logs', 'filter-log-events', '--log-group-name', group,
                    '--start-time', str(start_ms), '--end-time', str(end_ms),
                    '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1',
                    '--output', 'json', '--no-cli-pager', '--no-paginate',
                    '--limit', '1000', '--cli-connect-timeout', '3', '--cli-read-timeout', '10']
            if pattern:
                args += ['--filter-pattern', pattern]
            if token:
                args += ['--next-token', token]
            before = time.monotonic()
            row = {'group': name, 'query': query, 'page': page_number,
                   'timeoutMs': math.ceil(timeout * 1000), 'result': 'FAIL'}
            self.attempts.append(row)
            error = None
            try:
                result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                        env={**os.environ, 'AWS_MAX_ATTEMPTS': '1'})
                if time.monotonic() >= self.deadline:
                    error = 'LOG_TOTAL_DEADLINE_EXCEEDED'
                elif result.returncode:
                    error = safe_cli_error(result.stderr)
                elif len(result.stdout.encode()) > 4 * 1024 * 1024:
                    error = 'LOG_RESPONSE_LIMIT'
                else:
                    try:
                        page = json.loads(result.stdout)
                    except (ValueError, TypeError):
                        page = None
                    if (not isinstance(page, dict) or not isinstance(page.get('events'), list)
                            or len(page['events']) > 1000
                            or any(not isinstance(e, dict) or not isinstance(e.get('message'), str)
                                   for e in page['events'])
                            or ('nextToken' in page and (not isinstance(page['nextToken'], str)
                                                        or not 0 < len(page['nextToken']) <= 8192))):
                        error = 'LOG_INVALID_RESPONSE'
            except subprocess.TimeoutExpired:
                error = 'LOG_TOTAL_DEADLINE_EXCEEDED' if time.monotonic() >= self.deadline else 'LOG_READ_TIMEOUT'
            except OSError:
                error = 'LOG_CLI_UNAVAILABLE'
            row['elapsedMs'] = max(0, round((time.monotonic() - before) * 1000))
            if error:
                row['error'] = error
                self.fail(name, error)
                return
            row['result'] = 'PASS'
            yield page
            token = page.get('nextToken')
            if not token:
                return
            if token in seen or page_number == MAX_QUERY_PAGES:
                self.fail(name, 'LOG_PAGINATION_INCOMPLETE')
                return
            seen.add(token)

    def finish(self):
        if time.monotonic() >= self.deadline and not self.error:
            self.fail('collection', 'LOG_TOTAL_DEADLINE_EXCEEDED')
        return {'schemaVersion': 1, 'totalDeadlineMs': TOTAL_SECONDS * 1000,
                'callTimeoutMs': CALL_SECONDS * 1000, 'maxCalls': MAX_CALLS,
                'maxPagesPerQuery': MAX_QUERY_PAGES, 'exactBatchSize': EXACT_BATCH_SIZE,
                'readConcurrency': 1, 'automaticRetries': 0,
                'elapsedMs': max(0, int((time.monotonic() - self.started) * 1000)),
                'attempts': self.attempts, 'error': self.error}
