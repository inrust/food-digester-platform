# QA-09 default-off observer implementation evidence

Final controlled-runtime input: `matrix-03/matrix.json`. `matrix-01` keeps the earlier runner scope label and original source hashes; it is exploratory and is never rebound. `matrix-02` precedes final request-window and summary-completeness hardening; its original bytes and hashes also remain unchanged. The 14 real Prisma/controlled pg inputs preserve 34 original transactions and 48 checkouts/releases. Neither group uses a network/database server or target fixture. Actual Lambda business tests use local signed JWT/JWKS and PGlite; their missing pg ownership is explicitly degraded, not fabricated target proof.

Original failures remain in this directory, including the preexisting untracked build lint/format errors and the existing CPU test's timing-order failure. The final verification chain excludes build/ only from lint/format and otherwise follows package.json verify. No timing threshold was relaxed.

`verify-commands.json`, `tests.json`, `implementation.json`, and `manifest.json` bind final results and source bytes. Previous design evidence is anchored to 8af60f3, with historical source hashes verified at that commit, not substituted with intentionally changed current source.

```sh
node scripts/check-qa09-observer-implementation.mjs --check docs/audit/evidence/qa-09-observer-cost-implementation-2026-10-11
```

Gate: LOCAL_IMPLEMENTATION_PASS only after final sealing. Target wiring is implemented/default off, target execution NOT_RUN. Full QA-09 and P95 remain PARTIAL.
