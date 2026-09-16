/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Where the activation registry's gate modules live after W4, for the
 * suites that resolve a module from a registry key.
 *
 * W3 gave every gate a shim at src/<stem>.js; W4 (activation registry spec,
 * row 18) took the shims apart: the 25 predicate-only shims are gone and
 * their callers read the row through activeAt() by its literal key, the 10
 * logic-bearing modules moved to their feature directories as <stem>_gate.js
 * with the registry key stem unchanged, and the 27 twins stay at src/<stem>.js
 * for W5. A suite that walks the registry needs all three facts, so they are
 * written here once.
 *
 ********************************************************************/

'use strict';

const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');

// Registry key stem -> the module's path under src/. The stem is still the id
// the logic pin and the v2 fingerprint know the module by; only the file moved.
const GATE_MODULE_PATHS = Object.freeze({
    amount_representability_activation: 'utility/amount_representability_gate.js',
    attest_broadcast_fee_activation: 'actions/attest/attest_broadcast_fee_gate.js',
    attest_request_cap_activation: 'actions/attest/attest_request_cap_gate.js',
    caret_ref_strict_activation: 'db/database/caret_ref_strict_gate.js',
    dispense_payment_tally_scale_activation: 'actions/dispense/dispense_payment_tally_scale_gate.js',
    dispenser_send_amount_compare_activation: 'db/dispensers/dispenser_send_amount_compare_gate.js',
    ledger_amount_precision_activation: 'consensus/ledger_amount_precision_gate.js',
    oracle_preload_causality_activation: 'db/prices/oracle_preload_causality_gate.js',
    price_zero_validity_activation: 'actions/price/price_zero_validity_gate.js',
    slash_grid_activation: 'db/contracts/slash_grid_gate.js',
    capability_min_stake_history: 'consensus/capability_min_stake_history.js',
});

// The key stems whose predicate W4 replaced with activeAt(): no module exports
// these rows any more, the callers spell the key at the call site.
const REPLACED_STEMS = Object.freeze([
    'anchor_activation',
    'archive_batch_author_activation',
    'archive_head_unverified_gate_activation',
    'attest_admission_activation',
    'consolidation_leg_amount_activation',
    'dispense_cancelling_match_activation',
    'dispenser_amount_positivity_activation',
    'dispenser_caps_activation',
    'dispenser_freshness_activation',
    'dispenser_freshness_shape_activation',
    'dispenser_give_amount_activation',
    'dispenser_oracle_price_activation',
    'dispenser_ownership_cancel_activation',
    'gated_handoff_ref_activation',
    'list_owner_activation',
    'oracle_snapshot_age_causality_activation',
    'oracle_stale_round_visibility_activation',
    'price_fee_batch_landed_activation',
    'slash_ledger_consolidation_activation',
    'stake_key_reuse_activation',
    'sweep_zero_leg_activation',
    'tick_namespace_activation',
    'vm_deploy_lint_pkg3_activation',
    'vm_exec_lint_activation',
    'vm_lint_global_alias_activation',
]);

const REPLACED = new Set(REPLACED_STEMS);

/**
 * The absolute path of the module that exports a registry key's rows, or
 * null when W4 replaced that module's predicate with activeAt().
 * @param {string} stem  the registry key stem (`<stem>.<EXPORT>`)
 * @returns {?string}
 */
function modulePathFor(stem) {
    if (REPLACED.has(stem)) return null;
    return path.join(SRC, GATE_MODULE_PATHS[stem] || (stem + '.js'));
}

/**
 * Answers `value` for one registry key from the registry's activeAt() and
 * leaves every other key on the real predicate. Before W4 a suite stubbed the
 * shim's own predicate; the callers now read the row through the registry
 * module object, so this is the same seam one level down. Repeated calls in
 * one test re-use the one stub (sinon refuses to wrap a method twice), and
 * `sinon.restore()` puts the real activeAt() back.
 * @param {object} sinon  the suite's sinon (the default sandbox)
 * @param {string} key    the registry key, `<stem>.<EXPORT>`
 * @param {boolean} value what activeAt() answers for that key
 * @returns {object} the activeAt stub, for a later `.withArgs(key).returns(...)`
 */
function stubActiveAt(sinon, key, value) {
    const registry = require(path.join(SRC, 'consensus', 'gate_registry'));
    const stub = typeof registry.activeAt.restore === 'function'
        ? registry.activeAt
        : sinon.stub(registry, 'activeAt').callThrough();
    stub.withArgs(key).returns(value);
    return stub;
}

module.exports = { SRC, GATE_MODULE_PATHS, REPLACED_STEMS, modulePathFor, stubActiveAt };
