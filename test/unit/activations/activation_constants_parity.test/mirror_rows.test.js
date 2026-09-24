/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const registry = require('../../../../src/protocol_changes.js');
const constants = require('../../../../src/protocol/constants.js');

// Every export name the registry declares under two stems: the protocol/constants mirror row and the row the gate reads.
const MIRRORED = [
    'ANCHOR_REWARD_ACTIVATION',
    'ANCHOR_REWARD_AMOUNT',
    'ARCHIVE_REWARD_ACTIVATION',
    'ARCHIVE_REWARD_AMOUNT',
    'CHECKPOINT_COMMITMENT_ACTIVATION',
    'CROSS_CHAIN_ROYALTY_ACTIVATION',
    'EQUIV_HEADER_ACTIVATION',
    'PRICE_MAX',
    'STAKE_WEIGHTED_QUORUM_ACTIVATION',
    'STATE_COMMITMENT_ACTIVATION',
];

/** Registry keys grouped by export name, keeping only the names declared under two or more stems. */
function duplicatedNames() {
    const byName = new Map();
    for (const [key] of registry.rows()) {
        const name = key.slice(key.lastIndexOf('.') + 1);
        byName.set(name, (byName.get(name) || []).concat(key));
    }
    return new Map([...byName].filter(([, keys]) => keys.length > 1));
}

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    // Sibling-free on purpose: the copies are compared to each other, and the gate row's
    // parity to the documentation canon is the GATES cases' and the per-gate suites' job.
    it('holds every export name the registry declares twice value-identical across its copies', function () {
        const dupes = duplicatedNames();
        assert.deepStrictEqual([...dupes.keys()].sort(), MIRRORED,
            'the duplicated names moved: list a new second copy here, and delist a name whose twin was renamed or dropped');
        const drifted = [];
        for (const [name, keys] of dupes) {
            for (const key of keys.slice(1)) {
                try { assert.deepStrictEqual(registry.get(key), registry.get(keys[0])); } catch (e) {
                    drifted.push(name + ': ' + key + ' differs from ' + keys[0]);
                }
            }
        }
        assert.deepStrictEqual(drifted, [],
            'a one-sided flag-day edit forks the boundary src/protocol/constants.js publishes from the one consensus enforces');
    });

    it('publishes each duplicated name from src/protocol/constants.js equal to the row the gate reads', function () {
        for (const [name, keys] of duplicatedNames()) {
            const live = keys.filter((k) => !k.startsWith('protocol/constants.'));
            assert.strictEqual(live.length, 1, name + ' must have exactly one row outside protocol/constants, found ' + live.join(', '));
            assert.deepStrictEqual(constants[name], registry.get(live[0]),
                'src/protocol/constants.js ' + name + ' no longer matches ' + live[0]);
        }
    });
});
