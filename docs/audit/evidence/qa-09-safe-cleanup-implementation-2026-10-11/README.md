# QA-09 safe Cognito diagnostics and unknown-start local implementation

This is local implementation evidence. No new-SHA AWS execution, CI, deployment, nineteen-artifact collection, matched R0/R1 comparison, throughput or P95 acceptance is implied.

`verification-source.json` binds the exact six source/test files and package.json used by the local checks. `matrix.json` records20 Cognito and28 unknown-start cases (48 new cases) from the99-case focused run; the separate authentication/session regression has28 passing cases. All network responses/read dependencies in these matrices are controlled locally.

`full-verify/` runs all22 package.json verification steps in their original order. Only lint/format exclude the pre-existing untracked `build/` directory. The initial temporary-ignore-path invocation failed at formatting and remains under the root `verify-*` files; it is not a passing verify receipt. The corrected invocation uses the repository ignore rules and an explicit negative build glob. Local verification is limited to this declared scope.

Unknown-start selection has no mutation dependency. It resolves an existing Build identity only, never SQL results or cleanup. Zero matches, incomplete window, ambiguity or failed reads cannot prove nonexecution or permit restart. Failed GlobalSignOut remains failed despite successful deletion/absence verification. Existing target and historical evidence retain their original outcomes.

After the completed local validation, `check-local-seal.py --seal` binds local evidence, source, report and runbook. `check-local-seal.py --check` verifies those bytes without running tests, AWS, GitHub or business requests. The new target sequence remains NOT_RUN until the human GitHub Desktop push and same-SHA target receipts.
