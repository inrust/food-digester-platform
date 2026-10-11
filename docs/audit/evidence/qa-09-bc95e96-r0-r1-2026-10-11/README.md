# QA-09 bc95e96 observer-only R0/R1 target evidence

Application SHA: `bc95e9671a0bfb69effa95ad7c315b375199f132`.

Requested sequence: exact CI and default-off deployment/Amplify → 19 actual ZIPs and configuration → capacity-readonly and renewable session entry → R0 account-native/observer-off → cleanup → R1 account-native/observer-on → cleanup → all candidates off restore.

Actual sequence stopped on original R0 failure. Original child/parent/wrapper remain FAIL despite 116 business checks passing. The original business-audit StartBuild outcome remains UNKNOWN, and one original CustomerViewer GlobalSignOut remains FAIL. Identity deletion/absence, original database cleanup and independent planned final audit-empty established residual absence; this does not change the original failed gates. R1 was never dispatched. Restore run38111856409 succeeded; all five candidates are false, all19 code hashes and18 non-API revisions remain unchanged. Independent final audit-empty and both owned archive prefix reads passed. The final capacity-readonly start also became UNKNOWN, was never restarted, and has no final snapshot. Final post-restore readonly gate is PARTIAL. The final bounded inventory found10 exact known builds, all SUCCEEDED; both unknown Plans remain UNKNOWN despite zero exact matches in the covered window.

Inputs: `preflight/planned-inputs.json`. Offline argument checks: `preflight/helper-input-check.json`. Helpers copied into this new directory are adapted to the new SHA and observer-only pair; historical evidence is never executed in place or rebound. Their origin hashes remain in `preflight/helper-origin.json`.

Original CI attempt1 failure (`WINDOW_PARENT_CONTAINMENT`) is retained in `preflight/ci-original-fail.log`. Isolated caller-cpu passed; exact same-SHA failed CI job was rerun once as attempt2. This does not identify the first failure's timing cause. The first version read was BLOCKED by pending CI, with zero Lambda artifacts; its original bytes must remain preserved under `default-off/application-version-ci-pending.json` before the post-CI read.

No IAM/KMS/capacity changes, additional target sampling, shared resource restarts, invitation sends or git push. Each StartBuild has one original Plan; unknown starts are never replayed. Full QA-09/P95 and compiler/TCP/TLS causal attribution are not implied by individual stage passes.

`recovery/` contains explicit failed-sequence guards and readonly evidence recovery. The unknown business-audit Plan was never restarted; independent audit-empty uses its own planned readonly action. The exact recent shared-project Build inventory covers only known or exact prepared-source/Plan matches and cannot prove the unknown start never executed.

Prospective successful-pair helpers (`final-checks.py`, `seal-final.py`, `check-seal.py`, `compare-units.py`) remain unused. Only `recovery/final-failure-checks.py`, `recovery/seal-failed-sequence.py` and `recovery/check-failure-seal.py` validate and seal this failed-R0 outcome. Entry-bound helpers and historical implementation/task-list bytes remain unchanged.

Progress files are not a final seal. The final manifest retains sequence FAIL, QA-09 PARTIAL, R1 NOT_RUN and original UNKNOWN alongside any verified residual cleanup/default-off restore. Local syntax, document/hash/secret-pattern validation never upgrades target acceptance.
