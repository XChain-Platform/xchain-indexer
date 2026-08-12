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
 * state_root_version is derived PER HEIGHT, not from a constant and not from the
 * tip (SPV sub-tree design, Stage A item 3).
 *
 * getblockhashes is where this value is MINTED. The hub's checkpoint engine copies
 * it verbatim into the signed canonical string (StateCheckpointEngine builds `cp`
 * straight from `bh.state_root_version`), and from there it reaches the anchor row
 * on chain. So a wrong number here is not a display bug: it is signed by the
 * validator set and published.
 *
 * TWO FAILURE MODES, and the second is why the "no static constant" check alone is
 * not enough:
 *
 *   1. Reporting merkle.STATE_ROOT_VERSION, the frozen constant. Correct only while
 *      every extension is inert forever; the moment a slot arms, every armed block
 *      is labelled version 1 while committing a version-2 leaf set.
 *   2. Deriving at the CHAIN TIP instead of at the row's own height. This passes any
 *      check that merely greps for the constant, and it is wrong in the opposite
 *      direction: once a slot arms, every historical below-boundary checkpoint gets
 *      relabelled version 2, so the signed canonical claims those blocks committed a
 *      leaf set they did not.
 *
 * Both directions are pinned below, and pinned SIMULTANEOUSLY (armed-1 and armed
 * both served while the height is armed), because a one-directional test passes
 * under the tip-derived implementation.
 *
 * src/api.js calls startApi() at module load, so it cannot be required. This reads
 * and compiles the response literal, the same way api-pushgeneration-stamping.test.js
 * and api-auth-batch.test.js do, so the assertion executes the real shipped
 * expression rather than a paraphrase of it.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const merkle = require('../../src/merkle.js');
const SUB    = require('../../src/state_subtree_activation.js');

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

// Brace-match the getblockhashes success-response literal: a pure projection of
// (indexer, stored, blockHash, merkle, stateSubtree), so it needs no DB.
function responseLiteral() {
    const anchor = /return\s*\{\s*[\r\n]?\s*coin:/;
    const start  = API_SRC.indexOf('getblockhashes');
    assert.ok(start !== -1, 'getblockhashes handler not found in src/api.js');
    const body   = API_SRC.slice(start);
    const hit    = anchor.exec(body);
    assert.ok(hit, 'getblockhashes success-response literal not found');
    const open = body.indexOf('{', hit.index);
    let depth = 0;
    for (let i = open; i < body.length; i++) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}' && --depth === 0) return body.slice(open, i + 1);
    }
    throw new Error('unbalanced getblockhashes response literal');
}

const build = new Function('indexer', 'stored', 'blockHash', 'merkle', 'stateSubtree',
                           'return (' + responseLiteral() + ');');

const CHAIN = 'BTC', NETWORK = 'regtest';
const ARMED = 4242;

function report(blockIndex) {
    const indexer = { config: { COIN: CHAIN, NETWORK: NETWORK } };
    const stored  = {
        block_index:       blockIndex,
        block_time:        1700000000,
        ledger_hash:       'a1'.repeat(32),
        actions_hash:      'b2'.repeat(32),
        contract_hash:     'c3'.repeat(32),
        balances_root:     'd4'.repeat(32),
        stakes_root:       'e5'.repeat(32),
        state_root:        'f6'.repeat(32),
        block_merkle_root: '07'.repeat(32)
    };
    return build(indexer, stored, 'bb'.repeat(32), merkle, SUB);
}

function armed(fn) {
    const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
    const __k0 = CHAIN + ':' + NETWORK;
    const __hadPrior = Object.prototype.hasOwnProperty.call(map, __k0), __prior = map[__k0];
    map[CHAIN + ':' + NETWORK] = ARMED;
    try { return fn(); } finally {
        // RESTORE, never delete: a real armed height lives in this map now, and
        // deleting the key would disarm the chain for every later test in the
        // process (which is exactly how a green suite once hid a wrong answer).
        const __k = CHAIN + ':' + NETWORK;
        if(__hadPrior) map[__k] = __prior; else delete map[__k];
    }
}

describe('getblockhashes: state_root_version is derived at the row height @regression', function () {

    it('reports version 1 below the REAL armed height, and 2 at or above it', function () {
        // This chain (BTC:regtest) is armed at 10000 for real, so the surface
        // that mints the version must show the boundary rather than a constant.
        const LIVE = 10000;
        for (const h of [0, 1, LIVE - 1])
            assert.strictEqual(report(h).state_root_version, 1, 'height ' + h);
        for (const h of [LIVE, LIVE + 1, 999999999])
            assert.strictEqual(report(h).state_root_version, 2, 'height ' + h);
    });

    it('reports BOTH sides of the boundary correctly while a height is armed', function () {
        // The load-bearing vector. Both rows are served AFTER arming, so a
        // tip-derived implementation would answer 2 for both and fail the first
        // assertion, while a static-constant implementation answers 1 for both and
        // fails the second.
        armed(() => {
            assert.strictEqual(report(ARMED - 1).state_root_version, 1,
                'a block below the armed height committed the v1 leaf set and must still say so');
            assert.strictEqual(report(ARMED).state_root_version, 2,
                'the arming block committed an extension slot and must report version 2');
            assert.strictEqual(report(ARMED + 1).state_root_version, 2);
            assert.strictEqual(report(0).state_root_version, 1);
        });
    });

    it('is chain-local: arming BTC:regtest does not move LTC or another network', function () {
        armed(() => {
            const other = (coin, network) => {
                const indexer = { config: { COIN: coin, NETWORK: network } };
                const stored  = { block_index: ARMED, state_root: 'f6'.repeat(32),
                                  block_merkle_root: '07'.repeat(32), block_time: 1 };
                return build(indexer, stored, 'bb'.repeat(32), merkle, SUB).state_root_version;
            };
            assert.strictEqual(other('LTC', 'regtest'), 1, 'LTC is a different chain and is not armed');
            assert.strictEqual(other('BTC', 'testnet'), 1, 'BTC:testnet is a different key and is not armed');
            assert.strictEqual(other('BTC', 'regtest'), 2, 'the armed chain still reports 2 (guard is not vacuous)');
        });
    });

    it('still reports null when the row has no state_root (pre-flag-day block)', function () {
        // The version travels WITH its root: no root, no version, armed or not.
        armed(() => {
            const indexer = { config: { COIN: CHAIN, NETWORK: NETWORK } };
            const stored  = { block_index: ARMED, state_root: null, block_merkle_root: null, block_time: 1 };
            const out = build(indexer, stored, 'bb'.repeat(32), merkle, SUB);
            assert.strictEqual(out.state_root_version, null);
            assert.strictEqual(out.block_merkle_version, null);
        });
    });

    it('does not report the static merkle constant for an armed height', function () {
        // Kept as a distinct assertion because it is the one that fails loudly if
        // someone "simplifies" the derivation back to the constant.
        armed(() => {
            assert.notStrictEqual(report(ARMED).state_root_version, merkle.STATE_ROOT_VERSION,
                'an armed height must not report the frozen v1 constant');
        });
        assert.strictEqual(merkle.STATE_ROOT_VERSION, 1, 'the frozen constant itself must not move');
    });
});
