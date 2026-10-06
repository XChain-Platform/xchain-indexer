/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The gate list of the suite whose entry is test/unit/activations/activation_constants_parity.test.js,
 * derived from the activation modules on disk instead of trusted as hand-maintained. Every
 * gate carrier under src/ must be a module test/helpers/gate_modules.js knows, and every
 * stem it maps must either be pinned by a GATES row of the entry or be named below with the
 * reason it has no canonical map, so a new module that nobody listed fails here.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { SRC, GATE_MODULE_PATHS } = require('../../../helpers/gate_modules.js');

const ENTRY = path.resolve(__dirname, '..', 'activation_constants_parity.test.js');

// Files named *_gate.js or *_activation.js that are not activation carriers.
const NOT_CARRIERS = new Set([
    'api/auth_gate.js',
    'XChainIndexer/train_gate.js',
    'consensus/gates/list_meta_gate.js',
]);

// Carrier stems with no map in the canonical constants.js, so no parity row can exist.
const NO_CANONICAL_MAP = new Set([
    'amount_representability_activation',
    'archive_rollback_author_scope_activation',
    'capability_min_stake_history',
    'caret_ref_strict_activation',
    'dispense_payment_tally_scale_activation',
    'dispenser_send_amount_compare_activation',
    'equivocation_header',
    'ledger_amount_precision_activation',
    'oracle_preload_causality_activation',
    'price_batching_floor_activation',
    'price_zero_validity_activation',
    'rollcall_activation',
    'rollcall_gates_activation',
    'slash_grid_activation',
    'stake_weight_collation_activation',
    'stake_weighted_quorum',
    'stateHash',
    'state_commitment_activation',
    'state_subtree_activation',
    'swq_source_cap_activation',
]);

function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

function carriersOnDisk() {
    return walk(SRC, [])
        .map(file => path.relative(SRC, file).split(path.sep).join('/'))
        .filter(rel => /_(gate|activation)\.js$/.test(rel) && !NOT_CARRIERS.has(rel))
        .sort();
}

function pinnedStems() {
    const source = fs.readFileSync(ENTRY, 'utf8');
    const rows = source.match(/^\s*\['[^']+',\s*'[A-Za-z0-9_]+'\],?/gm) || [];
    return new Set(rows.map(row => row.match(/'([^']+)'/)[1].replace(/\.js$/, '')));
}

describe('activation-gate list is derived from the modules on disk @regression', function () {
    const mapped = new Map(Object.entries(GATE_MODULE_PATHS).map(([stem, rel]) => [rel, stem]));

    it('every gate carrier on disk is a module gate_modules.js maps to a registry stem', function () {
        const unmapped = carriersOnDisk().filter(rel => !mapped.has(rel));
        assert.deepStrictEqual(unmapped, [],
            'gate carriers with no GATE_MODULE_PATHS entry (add the stem, then a GATES row or a NO_CANONICAL_MAP line): ' + unmapped.join(', '));
    });

    it('every mapped carrier exists on disk', function () {
        const missing = [...mapped.keys()].filter(rel => !fs.existsSync(path.join(SRC, rel)));
        assert.deepStrictEqual(missing, [], 'GATE_MODULE_PATHS names files that are gone: ' + missing.join(', '));
    });

    it('every mapped stem has a GATES row in the parity entry or a stated reason it has none', function () {
        const pinned = pinnedStems();
        assert.ok(pinned.size >= 30, 'the GATES rows could not be read out of the entry, found ' + pinned.size);
        const unlisted = [...mapped.values()].filter(stem => !pinned.has(stem) && !NO_CANONICAL_MAP.has(stem));
        assert.deepStrictEqual(unlisted, [],
            'activation modules with no parity row: ' + unlisted.join(', '));
    });

    it('no exemption names a stem that is pinned or no longer mapped', function () {
        const pinned = pinnedStems();
        const stems = new Set(mapped.values());
        const stale = [...NO_CANONICAL_MAP].filter(stem => pinned.has(stem) || !stems.has(stem));
        assert.deepStrictEqual(stale, [], 'stale NO_CANONICAL_MAP entries: ' + stale.join(', '));
    });
});
