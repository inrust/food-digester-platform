# Offline contract dispatch boundaries

Authoritative current-source matrix: `matrix-final/matrix.json` (16 independent
serial processes, 36 transaction samples). The earlier `matrix/matrix.json`
remains a historical initial PASS before stricter interval validation and the
adapter marker refinement; do not use it as the current-source Gate.
`review-refinement.json` records that distinction and the intermediate expected
rejection-code assertion correction.

`boundary-summary.json` binds the descriptive first profile sample and the exact
historical target reference. Local Darwin/arm64 values do not explain or replace
AWS after-queue/prefix observations. The V8 location samples, process-all-thread
CPU deltas, nested target phases and boundary uncertainty cannot be added or
subtracted into a causal benefit or P95 result.

`verification.json` lists actual commands and results. `script-suite.log` retains
three sandbox listen EPERM failures; `script-suite-host.log` is the successful
same suite with local loopback ports allowed. No AWS or external publish action
was taken. Full 22-step verify and new hosted CI/target boundary runs were not run.

`manifest.json` seals this inventory, the new six source files, all matrix input
hashes, and the implementation/development documents. With the same lockfile
installation and generated Prisma Client, run:

```
python3 docs/audit/evidence/qa-09-dispatch-offline-2026-10-11/check-offline-seal.py --check
```

This checker only reads local files and invokes local receipt validators. It
never starts a fixture, database, deployment or AWS request. The offline runner
must use a fresh absent directory and does not replay an old matrix.

Current Gate: OFFLINE_BOUNDARY_PASS. Runtime wiring is not implemented;
readyToDeploy=false, new target boundary Gate=NOT_RUN, QA-09/P95=PARTIAL.
Existing candidates remain default-off. Source/config/workflow hashes and
historical sealed target evidence are checked locally, without claiming a fresh
AWS state observation.
