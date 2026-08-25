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
const fs     = require('fs');
const path   = require('path');
const { canonicalizeRewardType } = require('../../src/reward-push-gate');

// api.js is a server entrypoint and exports no controller, so the handler's gate is
// asserted the same way test/unit/api-federation-read-isolation.test.js asserts its
// apiView routing: over the handler's own source text.
const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
const PUSH_HANDLER_SRC = (function () {
    const start = API_SRC.indexOf('async pushvalidatorrewards(');
    assert.notStrictEqual(start, -1, 'pushvalidatorrewards handler not found in src/api.js');
    const end = API_SRC.indexOf('\n        // Resolve the staking source address', start);
    assert.notStrictEqual(end, -1, 'could not bound the pushvalidatorrewards handler body');
    return API_SRC.slice(start, end);
})();

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

// The gate key itself, separate from the reward_type spelling above.
//
// block_index arrives on the wire and is defaulted to 0 when absent, so keying the
// flag-day retirement on it alone made the gate advisory: a key-holder sending
// block_index 0 read every flag-day as inactive, got a wire-amount COLLECT-spendable
// row written, and the unconditional MIN(pubkey) reconcileAnchorRewardWinner collapse
// then DELETED the legitimately derived winner for that round. `round` is the binding
// plane for the per-chain legs: round_reference IS CHECKPOINT_SEQ and
// StateCheckpointEngine.deriveCheckpointSeq(snapshotBlock) returns snapshotBlock, so
// round IS the BTC snapshot_block, and reconcileAnchorRewardWinner keys on
// (reward_type, round_reference) - a forged row can only displace the derived winner
// while it carries the derived (post-flag-day) round.
describe('pushvalidatorrewards retirement gate key @regression @tier1', function () {

    it('gates the per-chain leg on round as well as the wire block_index', function () {
        const gate = PUSH_HANDLER_SRC.slice(PUSH_HANDLER_SRC.indexOf('anchor_(BTC|LTC|DOGE)'));
        const body = gate.slice(0, gate.indexOf('push retired'));
        assert.ok(/isAnchorRewardActive\(\s*Number\(blockIdx\)/.test(body),
            'per-chain gate must still consult the wire block_index');
        assert.ok(/isAnchorRewardActive\(\s*Number\(round\)/.test(body),
            'per-chain gate must ALSO consult round, or a key-holder lowers block_index and slips it');
    });

    it('combines the two planes with OR, never with a max() that NaN can poison', function () {
        // round is only checked for presence, never for numeric type, so Number(round) on a
        // non-numeric round is NaN and Math.max(NaN, x) is NaN. A max()-shaped gate key would
        // therefore hand the bypass straight back to any caller sending round: 'x'.
        assert.ok(!/Math\.max/.test(PUSH_HANDLER_SRC),
            'the retirement gate must not build its key with Math.max (NaN fails the gate open)');
    });

    // The ARCHIVE leg cannot borrow `round` the way the per-chain leg does:
    // anchor_archive's round_reference is MATCH_BATCH_SEQ, a dense hub-allocated
    // counter rather than a height, so it binds nothing. Left on the wire block_index
    // alone the gate was advisory in exactly the same way: block_index 0 read the
    // archive flag-day as inactive on mainnet, wrote a wire-amount COLLECT-spendable
    // row, and the MIN(pubkey) collapse then deleted the derived v6 winner. The plane
    // that binds instead is the node's own committed tip, which no request body moves.
    const ARCHIVE_GATE_SRC = (function () {
        const start = PUSH_HANDLER_SRC.indexOf("type === 'anchor_archive'");
        assert.notStrictEqual(start, -1, 'archive retirement leg not found in the push handler');
        const gate = PUSH_HANDLER_SRC.slice(start);
        const end  = gate.indexOf('ANCHOR v6');
        assert.notStrictEqual(end, -1, 'could not bound the archive retirement leg');
        return gate.slice(0, end);
    })();

    it('gates the archive leg on the node-local committed tip as well as the wire block_index', function () {
        assert.ok(/committedView\(\s*indexer\.indexerDb\s*\)\.getLatestBlockIndex\(\)/.test(ARCHIVE_GATE_SRC),
            'archive gate must consult the node-local committed tip, not only the wire block_index');
        assert.ok(/isArchiveRewardActive\(\s*Number\(tip\)/.test(ARCHIVE_GATE_SRC),
            'the local tip must be fed to isArchiveRewardActive as a gate plane');
        assert.ok(/isArchiveRewardActive\(\s*Number\(blockIdx\)/.test(ARCHIVE_GATE_SRC),
            'archive gate must still consult the wire block_index (OR-of-planes can only tighten)');
    });

    it('fails the archive leg closed when the local tip cannot be read', function () {
        assert.ok(/Number\.isFinite\(Number\(tip\)\)/.test(ARCHIVE_GATE_SRC),
            'an unreadable tip must be detected, not coerced into a gate plane');
        // The retry-ability of that refusal is load-bearing: RewardTracker.isTerminalPushError
        // matches /is not pushable|push retired|is required|must be an array/, so a transient
        // refusal carrying any of those words would be DROPPED instead of retried, turning a
        // DB blip into a permanently unpaid pre-flag-day archive reward.
        const transient = /error: 'anchor_archive gate[^']*'/.exec(ARCHIVE_GATE_SRC);
        assert.ok(transient,
            'an unreadable tip must refuse the push rather than fall through to the wire plane');
        assert.ok(!/is not pushable|push retired|is required|must be an array/i.test(transient[0]),
            'the unreadable-tip refusal must NOT read as terminal to RewardTracker.isTerminalPushError');
    });

    it('refuses an archive push outright on a non-BTC indexer', function () {
        assert.ok(/chain !== 'BTC'/.test(ARCHIVE_GATE_SRC),
            'the tip plane is a BTC-anchored height, so a non-BTC indexer must refuse rather than fall back');
        // This one IS terminal: the hub only ever pushes archive rewards to the BTC
        // indexer (RewardTracker._pushRewardsToBtcIndexer), so a retry can never succeed.
        assert.ok(/error: 'reward_type anchor_archive is not pushable[\s\S]*?push retired'/.test(ARCHIVE_GATE_SRC),
            'the wrong-chain refusal must read as terminal so the hub stops retrying');
    });

    it('still routes its writes through apiView so a push never joins the block transaction', function () {
        assert.ok(/indexer\.indexerDb\.apiView\(\)/.test(PUSH_HANDLER_SRC),
            'pushvalidatorrewards must write on the API view, not the block-loop connection');
    });
});
