# 5773ac9 bounded target receipts

Application commit: `5773ac9d7bad13d41c2d00e456f8b633fa939579`.
Business writes are confined to the current test environment and the two new,
independently owned business prefixes. Separate capacity plans use fresh prefixes
but remain transaction-read-only with no business writes.
No IAM/KMS/capacity changes, invitation delivery, forced cold starts,
extra business samples, or production execution were performed.

Authoritative execution receipts:

- `preflight/entry-completion.json`: immutable entry/helper/source/CI/default-off
  bindings, capacity and renewable-session admission.
- `r0/unit-completion.json`, `r1/unit-completion.json`: original 123-check business
  execution, original child/parent cleanup, independent database empty audit,
  12 negative GETs, 55 exact stage correlations, and sampled connection budget.
- `restore/restore-completion.json`: successful same-SHA deployment with all five
  candidates false, engine diagnosis true, 19 code hashes and 18 non-API revisions
  unchanged.
- `restore/post-restoration-readonly.json`, `restore/owned-domain-readonly.json`,
  `restore/owned-build-terminal-bounded.json`, `final-live-readonly.json`: final
  independent database/capacity, four exact S3 version domains, bounded known
  Build terminal state, and five existing run/version checks.
- `comparison.json`: strict observer-only inputs and naturally cold request
  compatibility; deliberately PARTIAL for causal benefit and performance/P95.
- `final-checks/summary.json`: local syntax, credential hygiene, immutable binding,
  historical seal, application source and completed-pair validation.
- `manifest.json`: exact file inventory and the current report hash. Check with
  `python3 docs/audit/evidence/qa-09-5773ac9-r0-r1-2026-10-11/check-current-seal.py --check`.

`preflight/helper-origin.json` records the 48 adapted helper templates from the
previous round; `preflight/entry-scope.json` freezes their current bytes. A helper
being present does not mean it executed. In particular, the copied historical
`final-checks.py` and old CI retry helpers are unused; current final validation is
`validate-current-pair.py`, with separate provenance. Only command/exit/result
receipts establish execution. Do not replay dispatch, StartBuild, business, or
cleanup commands from this directory.

The initial default-off verification downloaded all 19 ZIPs and checked their
bytes against Lambda CodeSha256. Later phases reused these verified same-SHA ZIP
bytes and freshly read all 19 configurations; artifact-reuse provenance and each
transition are recorded. They do not claim repeated ZIP downloads.

`contract-window-observations.json` and `transport-observations.json` only describe
existing exact requests, with no additional probes. Nested windows are not
additive; process CPU is not compiler-exclusive; outputs cannot be subtracted
from API latency to manufacture a benefit. A matched input Gate is not P95 or
full QA-09 acceptance. Historical UNKNOWN/FAIL receipts remain unchanged, and
normal cleanup success does not prove the new negative branches ran in AWS.

The final report is
`docs/audit/QA-09-5773ac9安全分类与未知启动R0-R1目标复验-2026-10-11.md`.
