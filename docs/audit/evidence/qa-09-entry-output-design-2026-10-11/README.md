# QA-09 public entry/output design evidence

Final inputs: `matrix-04/matrix.json`, `target-plan-final.json`, and the reproducible `decision-final.json`. Earlier `matrix-01`, `matrix-02`, `matrix-03`, `decision.json`, `target-plan.json` and their original source hashes remain exploratory snapshots; do not mix them into the final decision.

The final prototype preserves original synchronous public returns, lazy consumption, business results/errors, transaction ownership and original output delivery. The original output exception/reentrancy controls have EXPECTED_DEGRADED diagnostics, not fabricated full diagnostic success. CPU/timer measurement failure also degrades while preserving business behavior. Detailed intervals are offline only; the full proposed event is built in memory, bounded and never emitted.

Previous 185 sealed files and the previous manifest are anchored to commit 072b6bdf576383457ca930a3698dfaeb9f0d6fa1. All previous source/report bindings remain fixed except the task list's historical external snapshot; this round appends the list and binds its new state without editing the old seal. Historical 833 target files and existing 55 requests per group are replayed without new requests.

```sh
node scripts/check-qa09-entry-output-design.mjs --check docs/audit/evidence/qa-09-entry-output-design-2026-10-11
```

Gate: LOCAL_DESIGN_AND_OWNERSHIP_PASS. Decision: implement owned boundary bridge and bounded output observer with a default-off flag next. Target wiring/workflow input/collector are NOT_IMPLEMENTED; readyToDeploy=false. No target execution, compiler-only attribution or network-node attribution is established. Overall QA-09/P95 remains PARTIAL.

The original ESLint rejection of a caught explicit throw inside finally is retained in `lint-original-fail.log`. The safe conditional bookkeeping rewrite is bound to final `matrix-04`; final `lint.log` passes. Earlier matrix and test receipts remain intact.
