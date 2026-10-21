# Lane report: cx-xc-5989-p1

Files touched: bin/pins/at1-suite-titles.json (the test file itself was already committed by earlier rounds and is unchanged).

Cause of the last failure: the earlier pin re-take ran in an environment where the vendored xchain-vm directory is empty, so many test files failed to load and the re-taken pin dropped or rewrote unrelated entries (the 116 title_dropped lines). It also lagged develop.

Fix: merged origin/develop ('sync trunk'), took develop's pin as the base for the conflict, and added only this row's one title set (494348d00a38395f, 4 titles) plus its four file entries (test, test:regression, test:regression:fast, test:regression:full). The pin diff against develop is 10 added lines and nothing else.

Tests:
- mocha on the new test, guard_async_emission_deny.test.js and emission_routing.test.js: 32 passing, 0 failing.
- node bin/suite-title-map.js --compare: 0 title_dropped and no differences for this row's files. It still exits 1 with 6 collection_error entries because xchain-vm is missing in this hosted environment (Cannot find module 'xchain-vm'). These come from the environment, not from the pin; they cannot be fixed inside the surfaces. With xchain-vm present the compare should pass.

RUN-COMPLETE f49daa817bfb872838bd48b68fab5b45
