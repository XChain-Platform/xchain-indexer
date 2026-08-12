/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/reward-push-gate.test.js
 *
 * CONSENSUS/SECURITY REGRESSION GUARD for the pushvalidatorrewards ingest gate.
 *
 * A mixed-case per-chain anchor reward_type (e.g. 'anchor_btc') pushed over the
 * authenticated RPC would otherwise (a) slip the case-SENSITIVE #5311 flag-day
 * gate /^anchor_(BTC|LTC|DOGE)$/ and get written post-flag-day, and (b) because
 * validator_rewards is utf8_general_ci, collation-collide with the on-chain-
 * derived 'anchor_BTC' winner inside reconcileAnchorRewardWinner's MIN(pubkey)
 * collapse, deleting the legit derived row and forking that node from the fleet.
 * canonicalizeRewardType normalizes the case at the ingest boundary so neither
 * bypass is reachable. This file guards that normalization + the downstream gate
 * property it restores.
 */

'use strict';

const assert = require('assert');
const { canonicalizeRewardType } = require('../../src/reward-push-gate');

// The exact gate the handler applies to reject a per-chain anchor push once the
// flag-day is active (api.js pushvalidatorrewards). Kept in sync here so the test
// proves canonicalization makes a mixed-case push reachable to this gate.
const FLAG_DAY_CHAIN_GATE = /^anchor_(BTC|LTC|DOGE)$/;

describe('canonicalizeRewardType() forge-gate normalization @regression @tier1', function () {

    it('uppercases the chain suffix of a lowercase per-chain anchor reward', function () {
        assert.strictEqual(canonicalizeRewardType('anchor_btc'),  'anchor_BTC');
        assert.strictEqual(canonicalizeRewardType('anchor_ltc'),  'anchor_LTC');
        assert.strictEqual(canonicalizeRewardType('anchor_doge'), 'anchor_DOGE');
    });

    it('normalizes any mixed-case chain suffix to the canonical uppercase form', function () {
        assert.strictEqual(canonicalizeRewardType('anchor_BtC'),  'anchor_BTC');
        assert.strictEqual(canonicalizeRewardType('anchor_Ltc'),  'anchor_LTC');
        assert.strictEqual(canonicalizeRewardType('anchor_dOgE'), 'anchor_DOGE');
    });

    it('leaves an already-canonical per-chain anchor reward unchanged', function () {
        assert.strictEqual(canonicalizeRewardType('anchor_BTC'),  'anchor_BTC');
        assert.strictEqual(canonicalizeRewardType('anchor_LTC'),  'anchor_LTC');
        assert.strictEqual(canonicalizeRewardType('anchor_DOGE'), 'anchor_DOGE');
    });

    it('lowercases anchor_archive to its canonical form (the gate is case-sensitive)', function () {
        assert.strictEqual(canonicalizeRewardType('anchor_archive'), 'anchor_archive');
        assert.strictEqual(canonicalizeRewardType('Anchor_Archive'), 'anchor_archive');
        assert.strictEqual(canonicalizeRewardType('ANCHOR_ARCHIVE'), 'anchor_archive');
        // A decorated variant is not the archive type; left alone.
        assert.strictEqual(canonicalizeRewardType('anchor_archive_x'), 'anchor_archive_x');
    });

    it('passes non-chain reward types through verbatim (no over-normalization)', function () {
        assert.strictEqual(canonicalizeRewardType('oracle_round'),   'oracle_round');
        assert.strictEqual(canonicalizeRewardType('attest_fee'),     'attest_fee');
        // An unknown anchor_ subtype is not a live chain, so it is not rewritten.
        assert.strictEqual(canonicalizeRewardType('anchor_xyz'),     'anchor_xyz');
    });

    it('coerces null/undefined to an empty string without throwing', function () {
        assert.strictEqual(canonicalizeRewardType(null),      '');
        assert.strictEqual(canonicalizeRewardType(undefined), '');
    });

    it('does not partial-match a chain name embedded in a longer type', function () {
        // Only an exact anchor_<chain> is canonicalized; a decorated variant is left
        // alone (and would be rejected/handled as a non-chain type downstream).
        assert.strictEqual(canonicalizeRewardType('anchor_btc_x'), 'anchor_btc_x');
        assert.strictEqual(canonicalizeRewardType('xanchor_btc'),  'xanchor_btc');
    });

    it('makes a mixed-case per-chain push reachable to the flag-day gate (the forge fix)', function () {
        // Before the fix: the raw lowercase 'anchor_btc' does NOT match the case-
        // sensitive gate, so the flag-day rejection is skipped and the row is written.
        assert.strictEqual(FLAG_DAY_CHAIN_GATE.test('anchor_btc'), false,
            'raw lowercase must NOT match the case-sensitive gate (this is the bypass)');
        // After canonicalization the same push is caught by the gate.
        assert.strictEqual(FLAG_DAY_CHAIN_GATE.test(canonicalizeRewardType('anchor_btc')), true,
            'canonicalized form must match the gate so the flag-day rejection fires');
    });
});
