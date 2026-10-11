# QA-09 public CPU offline evidence — 2026-10-11

Final decision input: `matrix-03/matrix.json`. `matrix-01` retains the earlier proof implementation's input hashes; `matrix-02` overlapped the full local regression and is exploratory. Do not combine or select best samples across directories. All three original outputs remain immutable.

`history.json` replays 833 sealed historical files and exactly 55 existing requests per group, with zero additional requests. The historical external task-list binding is a snapshot; the newly appended task list is bound by this directory's own manifest, without modifying the old seal.

`offline-comparison.json` is reproduced by the current checker, including transaction totals and account + first load cost. `pnpm-test-sandbox-fail.log` preserves the original full-test failure: 1574 application and 302 contract tests passed; scripts had 3 loopback EPERM failures and 1 file-list ENOBUFS failure. `tests.json` and the later full script log distinguish the repaired validation from that failure.

Recheck without cloud or deployment actions:

```sh
node scripts/check-qa09-public-cpu-offline.mjs --check docs/audit/evidence/qa-09-public-cpu-offline-2026-10-11
```

Gate: LOCAL_OFFLINE_PASS only. Candidate defaults and application/deployment source remain unchanged. New-SHA target execution NOT RUN; overall QA-09/P95 PARTIAL. No compiler-only or network-node attribution is established.
