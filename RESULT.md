# Lane report: cx-xc-5610

## Files touched
74 files under src/ (unexported or inlined 168 of 172 names the dead-export scan listed; removed 7 helpers left unused: alterStatement, byTable, forMode, modifyClause, getCoinConfigByFullName, FULL_NAME_TO_TICK, replicaRollbackBuckets). Mixin methods called only via this in their own module became module-level functions named <name>Impl, invoked as <name>Impl.call(this, ...).

## Scan
conformance/dead-exports.txt is not in this repo, so I rebuilt the rule: an exported name (module.exports object keys, module.exports.x, exports.x) is dead when no tracked file other than its own module mentions it as a word. Before: 172 names. After: 4 names remain.

## Parked (needs a file outside src)
These 4 names are still dead. Their modules are hashed by logic pins in bin/pins/carrier-logic.json, so editing them fails test/unit/repo_guards/carrier_logic_pin.test.js until re-pinned with bin/lib/carrier_logic_pin.js --write, which is outside Surfaces:
- src/consensus/gates/mirror_admission_margin_gate.js chainMarginBlocks
- src/consensus/gates/price_scale_gate.js isValidPriceValue
- src/consensus/gates/stake_weight_collation_gate.js normalizeCollationName
- src/consensus/gates/train_gate.js parseRuleSetVersion
The acceptance (scan lists no name) is therefore NOT fully met until those are re-pinned and unexported.

## Tests
xchain-vm is not vendored here, so `npm test` aborts at load. I ran each test file in test/unit, test/regression, test/security separately with mocha (1509 files), before and after, in a scratch worktree.
- Baseline: 13899 passing, 27 files with failures (pre-existing, mostly missing xchain-vm / DB).
- After: identical per-file pass/fail except two artifacts: hub_db_sync_watchdog_transport (flaky, 3 passing on rerun) and xcall-constants-cross-repo (fails only because the scratch worktree path is not named as a repo). carrier_logic_pin failed after the gate edits; those four gate files were reverted and it passes again (15 passing).

## Notes
Moved functions keep their bodies; one-line dedent only. Pre-existing unused locals (gateRegistry, actionIndex, sqlModeIsPinned, defaultUrls) were left alone.

RUN-COMPLETE a89bd906b61b301a5ccdd7040425c1fb
