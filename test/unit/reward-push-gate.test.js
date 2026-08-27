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
 * CONSENSUS/SECURITY REGRESSION GUARD for the RETIRED validator-reward push rail.
 *
 * pushvalidatorrewards was a key-authenticated JSON-RPC that wrote rows into
 * validator_rewards, which COLLECT can spend. Every reward it carried is now
 * derived from on-chain bytes instead: oracle_round / attest_fee / attest_bcast
 * during block processing, anchor_<CHAIN> from the ANCHOR v4/v5 publisher
 * attestation, anchor_archive from the ANCHOR v6 one. Mainnet is past both
 * anchor flag-days and both sit at 0 on testnet and regtest, so the staged gates
 * that used to stand in the handler refused every push on every live network.
 * The write path is now DELETED rather than gated.
 *
 * What this file pins:
 *   - the refusal answers EVERY reward type, including one nobody has minted yet,
 *     and reads as terminal to the hub's push loop so a stale hub drops instead
 *     of looping against a node that will never accept;
 *   - the handler holds no write path at all, so no gate input, forged or
 *     otherwise, can reach createValidatorReward or the smallest-pubkey
 *     reconcileAnchorRewardWinner collapse.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { canonicalizeRewardType, rewardPushRetiredError } = require('../../src/reward-push-gate');

// api.js is a server entrypoint and exports no controller, so the handler itself is
// asserted the same way test/unit/api-federation-read-isolation.test.js asserts its
// apiView routing: over the handler's own source text. The refusal it returns is
// exercised as behaviour through rewardPushRetiredError below.
const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
const PUSH_HANDLER_SRC = (function () {
    const start = API_SRC.indexOf('async pushvalidatorrewards(');
    assert.notStrictEqual(start, -1, 'pushvalidatorrewards handler not found in src/api.js');
    const end = API_SRC.indexOf('\n        // Resolve the staking source address', start);
    assert.notStrictEqual(end, -1, 'could not bound the pushvalidatorrewards handler body');
    return API_SRC.slice(start, end);
})();

// The hub's terminal-refusal predicate (xchain-hub RewardTracker.isTerminalPushError).
// An error matching it stops the push immediately; anything else burns the retry budget.
const HUB_TERMINAL_PUSH_ERROR = /is not pushable|push retired|is required|must be an array/i;

// Every reward type the rail ever carried, plus shapes a caller can invent.
const EVERY_PUSHED_TYPE = [
    'anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_archive',
    'anchor_btc', 'anchor_BtC', 'Anchor_Archive', 'ANCHOR_ARCHIVE',
    'oracle_round', 'attest_fee', 'attest_bcast',
    'anchor_xyz', 'anchor_btc_x', 'xanchor_btc', '', 'not a type',
];

describe('pushvalidatorrewards is retired for every reward type @regression @tier1', function () {

    it('refuses every reward type the rail ever carried, and every invented one', function () {
        for (const type of EVERY_PUSHED_TYPE) {
            const err = rewardPushRetiredError(type);
            assert.strictEqual(typeof err, 'string', 'no reward type may resolve to an acceptance: ' + type);
            assert.ok(err.length > 0, 'the refusal must carry a reason: ' + type);
        }
    });

    it('refuses a missing / null / non-string reward_type without throwing', function () {
        for (const type of [undefined, null, 0, {}, [], true]) {
            const err = rewardPushRetiredError(type);
            assert.strictEqual(typeof err, 'string');
            assert.ok(err.length > 0);
        }
        // An absent type still names itself, so an operator reading the log can tell a
        // malformed push apart from one that named a real reward.
        assert.match(rewardPushRetiredError(undefined), /\(unset\)/);
    });

    it('reads as TERMINAL to the hub push loop, so a stale hub drops instead of looping', function () {
        // A refusal the hub does not recognise is treated as transient and re-posted
        // pushMaxAttempts times against a node whose answer can never change.
        for (const type of EVERY_PUSHED_TYPE.concat([undefined, null])) {
            assert.match(rewardPushRetiredError(type), HUB_TERMINAL_PUSH_ERROR,
                'refusal for ' + String(type) + ' must match the hub terminal-error predicate');
        }
    });

    it('names the reward with the spelling the derived row carries', function () {
        // The derived winner is written as 'anchor_' + CHAIN.toUpperCase(), so a refusal
        // logged for 'anchor_btc' should name the same reward an operator sees on the
        // derive side rather than a second spelling of it.
        assert.match(rewardPushRetiredError('anchor_btc'), /anchor_BTC/);
        assert.match(rewardPushRetiredError('Anchor_Archive'), /anchor_archive/);
    });
});

describe('pushvalidatorrewards holds no write path @regression @tier1', function () {

    it('never reaches the reward writer', function () {
        assert.ok(!/createValidatorReward/.test(PUSH_HANDLER_SRC),
            'the retired rail must not be able to mint a COLLECT-spendable validator_rewards row');
    });

    it('never reaches the smallest-pubkey reconcile that DELETES rows', function () {
        // This collapse was the destructive half of the forge: a pushed row sharing a
        // round with the derived winner deleted that winner.
        assert.ok(!/reconcileAnchorRewardWinner/.test(PUSH_HANDLER_SRC),
            'the retired rail must not be able to delete a derived reward row');
    });

    it('opens no database connection at all', function () {
        assert.ok(!/apiView\(\)/.test(PUSH_HANDLER_SRC),
            'a handler that only refuses has no reason to draw a pooled connection');
        assert.ok(!/committedView\(/.test(PUSH_HANDLER_SRC),
            'the committed-tip read existed only to give the archive gate a second plane');
    });

    it('answers from the refusal helper rather than re-deriving a flag-day in the handler', function () {
        assert.ok(/rewardPushRetiredError\(\s*reward_type\s*\)/.test(PUSH_HANDLER_SRC),
            'the handler must answer with the shared refusal, which the hub predicate is pinned against');
        assert.ok(!/isAnchorRewardActive|isArchiveRewardActive/.test(PUSH_HANDLER_SRC),
            'no flag-day may be consulted here: a re-introduced gate is a re-introduced admitted case');
    });

    it('is still listed as a WRITE method, so it stays key-gated', function () {
        // The method no longer writes, but leaving it ungated would expose an
        // unauthenticated probe of a consensus node for no gain.
        assert.match(API_SRC, /WRITE_METHODS\s*=\s*new Set\(\[\s*'pushvalidatorrewards'/,
            'the retired method must remain behind the API key');
    });
});

// The reward_type canonicalization outlives the gate it was built for: the refusal
// above names the type with it, and the uppercase-chain invariant it documents is
// still load-bearing on the derive side (see anchorRewardCanonicalGolden.test.js).
describe('canonicalizeRewardType() naming @regression @tier1', function () {

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

    it('lowercases anchor_archive to its canonical form', function () {
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
        assert.strictEqual(canonicalizeRewardType('anchor_btc_x'), 'anchor_btc_x');
        assert.strictEqual(canonicalizeRewardType('xanchor_btc'),  'xanchor_btc');
    });
});
