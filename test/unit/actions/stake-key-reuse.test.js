'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// STAKE v1 signing-key REUSE flag day (src/stake_key_reuse_activation.js).
//
// WHAT IS PROVEN HERE, AND WHAT IS PROVEN ELSEWHERE. The verdicts below are the
// ones an operator sees, so they are asserted at the ACTION layer over row sets:
// one key, one row set, two heights, and the STATUS the handler writes. The SQL
// that produces those row sets is pinned separately, by text and by bind args,
// in test/unit/db.queries.test.js against the real Database method. Neither half
// stands alone: this file would pass against a double that disagreed with the
// query, and that file would pass against a query no caller reached. Read the
// two together.
//
// The double below is the two predicates db.js writes, transcribed once:
//   legacy (blockIndex null)  - no activation/deactivation clause at all, so
//                               EVERY valid row counts and the key stays burned
//   reuseBlockingOnly         - every row regardless of activation state, minus
//                               the rows deactivated AND past cooldown
// A drift between the transcription and the SQL is exactly what the query-shape
// cases in db.queries.test.js exist to catch.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Stake          = require('../../../src/actions/stake.js');
const configModule   = require('../../../src/config.js');
const stakeKeyReuse  = require('../../../src/stake_key_reuse_activation.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const PUBKEY = 'b'.repeat(64);

// Read the boundary off the module rather than hardcoding it, so a re-pinned
// height moves these cases with it instead of reddening them.
const GATE       = stakeKeyReuse.STAKE_KEY_REUSE_ACTIVATION['BTC:testnet'];
const AT_GATE    = GATE;
const BELOW_GATE = GATE - 1;

// Real BTC staking parameters, not invented ones: the cooldown arithmetic under
// test is the same arithmetic UNSTAKE and the ROLLCALL eviction apply.
const TESTNET_CONFIG   = configModule.getConfig('BTC', 'testnet');
const MAINNET_CONFIG   = configModule.getConfig('BTC', 'mainnet');
const COOLDOWN_BLOCKS  = TESTNET_CONFIG['STAKING']['COOLDOWN_BLOCKS'];
const ACTIVATION_DELAY = TESTNET_CONFIG['STAKING']['ACTIVATION_DELAY_BLOCKS'];

// Row builders named for the four states the ruling distinguishes. `block` is the
// height the STAKE or the UNSTAKE/eviction landed at, and the derived columns use
// the production arithmetic so a row here is shaped like a row on chain.
function stakedAt(block) {
    return { block_index: block, activation_block: block + ACTIVATION_DELAY, deactivation_block: null };
}
// UNSTAKE at `unstakeBlock`: setStakeDeactivationByPubkey stamps
// unstakeBlock + ACTIVATION_DELAY_BLOCKS.
function unstakedAt(stakeBlock, unstakeBlock) {
    const row = stakedAt(stakeBlock);
    row.deactivation_block = unstakeBlock + ACTIVATION_DELAY;
    return row;
}
// ROLLCALL eviction at `closeBlock`: setStakeDeactivationBySourceAndPubkey stamps
// closeBlock + ACTIVATION_DELAY_BLOCKS, the identical column and arithmetic. The
// predicate cannot tell the two apart, which is the ruling, so the two builders
// differ only in name.
function evictedAt(stakeBlock, closeBlock) {
    return unstakedAt(stakeBlock, closeBlock);
}

// The two db.js predicates over an in-memory row set. Returns the aggregate shape
// getActiveStakeByPubkey returns, or null when nothing matched.
function rowSetDb(rows) {
    return async function (pubkey, blockIndex, opts) {
        let matched;
        if (blockIndex === null || blockIndex === undefined) {
            // Legacy: db.js gates the whole activation/deactivation clause on a
            // non-null blockIndex, so a null one counts every valid row ever.
            matched = rows.slice();
        } else if (opts && opts.reuseBlockingOnly) {
            // AND (s.deactivation_block IS NULL OR s.deactivation_block + ? > ?)
            matched = rows.filter(r => r.deactivation_block === null ||
                                       (r.deactivation_block + COOLDOWN_BLOCKS) > blockIndex);
        } else {
            // AND s.activation_block <= ? AND (deactivation_block IS NULL OR > ?)
            matched = rows.filter(r => r.activation_block <= blockIndex &&
                                       (r.deactivation_block === null || r.deactivation_block > blockIndex));
        }
        if (matched.length === 0) return null;
        return {
            source_id: 42, signing_pubkey_id: 3, signing_pubkey: pubkey,
            amount: '500.00000000', activation_block: matched[0].activation_block,
            block_index: matched[0].block_index, status_id: 1
        };
    };
}

// Drive one STAKE v1 through the handler against `rows` at `blockIndex` on
// `config`, and hand back the STATUS the handler wrote.
async function stakeVerdict(rows, blockIndex, config) {
    const indexer = createMockIndexer();
    sinon.stub(indexer.util, 'logError');

    indexer.indexerDb.createStake            = sinon.stub().resolves();
    indexer.indexerDb.getDelegationByPubkey  = sinon.stub().resolves(null);
    indexer.indexerDb.getStatusString        = sinon.stub().resolves('valid');
    indexer.indexerDb.getActiveStakeByPubkey = sinon.spy(rowSetDb(rows));
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 }));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '10000.00000000' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressId.resolves(42);
    indexer.util.resetLists();

    const handler = new Stake({
        config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        processAction:   sinon.stub().resolves(),
    });

    const data = createBaseData({
        ACTION: 'STAKE', COIN: 'BTC', FORMAT: 1, BLOCK_INDEX: blockIndex, SOURCE
    });
    await handler.parse(['1', '500.00000000', PUBKEY], data, null);
    return { status: data.STATUS, call: indexer.indexerDb.getActiveStakeByPubkey.firstCall };
}

describe('STAKE v1 signing-key reuse flag day @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    it('is not vacuous: BTC:testnet is armed at a height above genesis', function () {
        assert.ok(Number.isFinite(GATE) && GATE > 0,
            'BTC:testnet must be armed for the boundary cases below to mean anything');
    });

    describe('a key that unstaked voluntarily and sat out its cooldown', function () {
        // Unstaked far enough back that deactivation_block + COOLDOWN_BLOCKS is well
        // below both heights under test, so the ONLY thing that moves is the gate.
        const rows = () => [unstakedAt(1000, 2000)];

        it('is still REFUSED below the gate (the legacy predicate, byte for byte)', async function () {
            const { status } = await stakeVerdict(rows(), BELOW_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });

        it('is ADMITTED at the gate, same key and same row set', async function () {
            const { status } = await stakeVerdict(rows(), AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'valid');
        });

        it('below the gate the query is the legacy null-blockIndex call with no opts', async function () {
            const { call } = await stakeVerdict(rows(), BELOW_GATE, TESTNET_CONFIG);
            assert.strictEqual(call.args[1], null, 'legacy branch must pass blockIndex null');
            assert.strictEqual(call.args[2], undefined, 'legacy branch must select no query mode');
        });

        it('at the gate the query is the reuse-blocking mode at the real block', async function () {
            const { call } = await stakeVerdict(rows(), AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(call.args[1], AT_GATE);
            assert.deepStrictEqual(call.args[2], { reuseBlockingOnly: true });
        });
    });

    describe('a key that ROLLCALL evicted', function () {
        it('is ADMITTED at the gate, exactly as an unstaked key is', async function () {
            const { status } = await stakeVerdict([evictedAt(1000, 2000)], AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'valid');
        });

        it('is REFUSED below the gate, exactly as an unstaked key is', async function () {
            const { status } = await stakeVerdict([evictedAt(1000, 2000)], BELOW_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });
    });

    describe('the states that still hold a key, at and above the gate', function () {

        it('a PENDING-ACTIVATION row refuses (the hole the null blockIndex was avoiding)', async function () {
            // Staked two blocks ago, so activation_block is still ahead of the block
            // being parsed. The legacy activation filter would have hidden this row.
            const rows = [stakedAt(AT_GATE - 2)];
            assert.ok(rows[0].activation_block > AT_GATE, 'fixture must be pending activation');
            const { status } = await stakeVerdict(rows, AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });

        it('a DEACTIVATED row still inside cooldown refuses', async function () {
            const rows = [unstakedAt(AT_GATE - 5000, AT_GATE - 100)];
            assert.ok(rows[0].deactivation_block + COOLDOWN_BLOCKS > AT_GATE,
                'fixture must still be inside cooldown');
            const { status } = await stakeVerdict(rows, AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });

        it('an ACTIVE row refuses', async function () {
            const rows = [stakedAt(1000)];
            const { status } = await stakeVerdict(rows, AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });

        it('one cooled row does not excuse a second row that is still active', async function () {
            // EVERY row must be released, not merely one of them.
            const { status } = await stakeVerdict([unstakedAt(1000, 2000), stakedAt(1000)],
                                                  AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });
    });

    describe('the cooldown boundary', function () {
        it('admits at exactly deactivation_block + COOLDOWN_BLOCKS', async function () {
            const row = unstakedAt(1000, AT_GATE - COOLDOWN_BLOCKS - ACTIVATION_DELAY);
            assert.strictEqual(row.deactivation_block + COOLDOWN_BLOCKS, AT_GATE,
                'fixture must land the cooldown end exactly on the block being parsed');
            const { status } = await stakeVerdict([row], AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'valid');
        });

        it('refuses one block earlier', async function () {
            const row = unstakedAt(1000, AT_GATE - COOLDOWN_BLOCKS - ACTIVATION_DELAY + 1);
            assert.strictEqual(row.deactivation_block + COOLDOWN_BLOCKS, AT_GATE + 1);
            const { status } = await stakeVerdict([row], AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
        });
    });

    describe('the unchanged cases', function () {
        it('a key with no stake rows is admitted below the gate', async function () {
            const { status } = await stakeVerdict([], BELOW_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'valid');
        });

        it('a key with no stake rows is admitted at the gate', async function () {
            const { status } = await stakeVerdict([], AT_GATE, TESTNET_CONFIG);
            assert.strictEqual(status, 'valid');
        });

        it('an INERT network runs the legacy predicate at any height', async function () {
            // Mainnet is the null sentinel: a cooled key stays refused however high the
            // block, which is the deployed behaviour a one-sided arming would break.
            const { status, call } = await stakeVerdict([unstakedAt(1000, 2000)], 9000000, MAINNET_CONFIG);
            assert.strictEqual(status, 'invalid: SIGNING_PUBKEY (already in use)');
            assert.strictEqual(call.args[1], null);
        });
    });
});

describe('stake_key_reuse_activation gate resolution @regression @tier1', function () {
    const { isStakeKeyReuseActive, STAKE_KEY_REUSE_ACTIVATION } = stakeKeyReuse;

    it('regtest is genesis-active', function () {
        assert.strictEqual(STAKE_KEY_REUSE_ACTIVATION.regtest, 0);
        assert.strictEqual(isStakeKeyReuseActive(0, 'regtest', 'BTC'), true);
    });

    it('mainnet is the inert null and reads as off at every height', function () {
        assert.strictEqual(STAKE_KEY_REUSE_ACTIVATION['BTC:mainnet'], null);
        assert.strictEqual(isStakeKeyReuseActive(0, 'mainnet', 'BTC'), false);
        // The coercion this guards: `b >= null` is `b >= 0`, which would arm the
        // widening on every block of an unratified chain.
        assert.strictEqual(isStakeKeyReuseActive(9000000, 'mainnet', 'BTC'), false);
    });

    it('is armed per coin on testnet and flips exactly at the height', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            const h = STAKE_KEY_REUSE_ACTIVATION[coin + ':testnet'];
            assert.ok(Number.isFinite(h) && h > 0, coin + ':testnet must be armed');
            assert.strictEqual(isStakeKeyReuseActive(h - 1, 'testnet', coin), false);
            assert.strictEqual(isStakeKeyReuseActive(h,     'testnet', coin), true);
        }
    });

    it('prefers the coin key over the bare network key', function () {
        // testnet's bare key is the inert null, so a hit on it instead of the coin key
        // would read as off at a height the coin key arms.
        assert.strictEqual(STAKE_KEY_REUSE_ACTIVATION.testnet, null);
        assert.strictEqual(isStakeKeyReuseActive(STAKE_KEY_REUSE_ACTIVATION['BTC:testnet'], 'testnet', 'BTC'), true);
    });

    it('falls back to the bare network key for a coin with no entry', function () {
        assert.strictEqual(isStakeKeyReuseActive(0, 'regtest', 'ZZZ'), true);
        assert.strictEqual(isStakeKeyReuseActive(9000000, 'testnet', 'ZZZ'), false);
    });

    it('fails CLOSED on an unknown network', function () {
        assert.strictEqual(isStakeKeyReuseActive(9000000, 'devnet', 'BTC'), false);
    });

    it('fails CLOSED on an unusable height, genesis-armed network included', function () {
        // Number(null), Number('') and Number(false) are all a finite 0, which on
        // regtest would read as ACTIVE and widen the predicate for an action carrying
        // no block index at all.
        for (const bad of [null, undefined, '', false, true, NaN, 'abc', {}])
            assert.strictEqual(isStakeKeyReuseActive(bad, 'regtest', 'BTC'), false,
                'unusable height ' + String(bad) + ' must not arm the gate');
    });
});
