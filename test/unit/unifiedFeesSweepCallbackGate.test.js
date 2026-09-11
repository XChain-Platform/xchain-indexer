/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * test/unit/unifiedFeesSweepCallbackGate.test.js
 *
 * The flag day that moves SWEEP and CALLBACK off the legacy per-DB-hit fee and
 * onto the unified gas schedule.
 *
 * fees.AMOUNT is a consensus-visible ledger amount: it is the fee DEBIT, and it is
 * hashed into balances_root and ledger_hash. So the price cannot simply change.
 * This suite pins the three things nothing else can catch:
 *
 *   - the REGISTRATION: a time-keyed 0.2.0 change, genesis-active on regtest so
 *     every suite and regtest venue runs the unified price from block 0;
 *   - that MAINNET IS ARMED AT GENESIS and TESTNET IS NOT, which is the whole point
 *     of this pair. The 2026-09-09 ruling armed mainnet at 0 because mainnet has
 *     never carried a SWEEP or a CALLBACK, so the re-pricing cannot move a fee
 *     DEBIT a from-genesis replay recomputes. Testnet went PUBLIC on 2026-09-01
 *     and has carried both actions since, so a genesis arm there WOULD re-price
 *     committed fees and fork every synced node against a fresh reindex; it takes
 *     a future instant instead;
 *   - that the testnet instant is never BACKDATED, and that mainnet is armed at
 *     exactly 0 rather than at some other past value. The two are not the same
 *     thing: 0 means the rule always applied, which a replay reproduces exactly,
 *     while a nonzero past instant means the price changed at a moment the fleet
 *     never observed, which is the fork this gate exists to prevent.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

const GATE = 'UNIFIED_FEES_SWEEP_CALLBACK';

// The house UNARMED sentinel. No slot of this gate may hold it any more: mainnet is
// armed at genesis and testnet at a named instant, so a sentinel here means an arm was
// reverted without a ruling behind it.
const UNARMED_SENTINEL = 9999999999;

// The public testnet launch. Nothing may arm this gate at or before it.
const TESTNET_LAUNCH = 1788220800; // 2026-09-01T00:00:00Z

// The pinned testnet instant, read from the module so a re-pin forward moves the
// boundary tests with it rather than reddening them.
const TESTNET_INSTANT = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '0.2.0'), indexer };
}

describe('SWEEP/CALLBACK unified-fee flag day @regression @tier1', function(){

    describe('registration', function(){

        it('is a time-keyed 0.2.0 change, genesis-active on regtest', function(){
            const change = pcFor('regtest').pc.changes[GATE];
            assert.ok(change, GATE + ' must be registered');
            assert.strictEqual(change.version_major, 0);
            assert.strictEqual(change.version_minor, 2);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed: SWEEP and CALLBACK run on BTC, LTC and DOGE, whose heights
            // diverge by millions of blocks, so no single height names one cutover across
            // all three but a single timestamp does.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            assert.strictEqual(change.regtest_time, 0);
        });

        it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling', function(){
            const instant = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, instant);
            // 0, and nothing else. Mainnet has never carried a SWEEP or a CALLBACK
            // (measured 2026-09-09), so the unified price has effectively always applied
            // there and a genesis arm reproduces every recorded fee DEBIT. Any OTHER past
            // value would be the harmful case: a price that changed at an instant the
            // fleet never observed. Any future value would be a flag day nothing needs.
            assert.strictEqual(instant, 0,
                'mainnet must be armed at genesis, not at a sentinel and not at an instant');
            assert.notStrictEqual(instant, UNARMED_SENTINEL);
        });

        it('mainnet: ACTIVE from block 0 and at every instant above it', async function(){
            for(const t of [0, 1, 1786060800, Math.floor(Date.now() / 1000)]){
                const { pc, indexer } = pcFor('mainnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 0), true,
                    'mainnet must price SWEEP and CALLBACK on the unified schedule at block_time ' + t);
            }
        });

        it('testnet is NOT armed at genesis, because testnet is a live public ledger', function(){
            const instant = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('testnet').pc.changes[GATE].testnet_time, instant);
            assert.notStrictEqual(instant, 0,
                'a genesis testnet arm re-prices SWEEPs and CALLBACKs already committed on the ' +
                'public testnet and forks every synced node against a fresh reindex');
            assert.ok(instant > TESTNET_LAUNCH,
                'the testnet instant must be after the public launch, never inside committed history');
        });

        it('the testnet instant is never backdated', function(){
            // An activation already in the past is not a flag day at all. This is a
            // wall-clock assertion on purpose: it starts failing the moment the pinned
            // instant lapses, which is exactly when it must be re-pinned forward (the
            // v0.17.0 train carries it; a slipped train defers the instant).
            // Mainnet is exempt because it is armed at genesis, not at an instant: 0 is
            // "the rule always applied", which is the one past value that cannot diverge
            // a replay from the fleet. That distinction is asserted above.
            const now     = Math.floor(Date.now() / 1000);
            const instant = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME;
            assert.ok(instant > now,
                'testnet instant ' + instant + ' has lapsed: re-pin it forward, or the ' +
                'live fleet applies the legacy price past it while a replay applies the new one');
        });

        it('regtest: active from genesis, so suites and venues run the unified price', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('testnet: inert below its instant, active at and above it', async function(){
            // The committed testnet history this gate must not re-price sits below the
            // instant, so every one of these times must still take the legacy price.
            for(const t of [1, TESTNET_LAUNCH, TESTNET_INSTANT - 1]){
                const { pc, indexer } = pcFor('testnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 1000000), false,
                    'testnet must still be inert at block_time ' + t);
            }
            for(const t of [TESTNET_INSTANT, TESTNET_INSTANT + 315360000]){
                const { pc, indexer } = pcFor('testnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 1000000), true,
                    'testnet must take the unified price at block_time ' + t);
            }
        });
    });

    describe('relationship to the fee gates it sits beside', function(){

        // LEGACY_FEE_NUMERIC_DBHITS only has meaning while the legacy branch is still the
        // one running. On testnet and regtest this gate sits at or above it, so the
        // recorded activation order reads the way a replay walks it.
        for(const network of ['testnet','regtest']){
            it(network + ': never activates before the legacy accumulator fix', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const legacy  = changes['LEGACY_FEE_NUMERIC_DBHITS'];
                assert.ok(gate && legacy, 'both gates must be registered');
                assert.ok(gate[network + '_time'] >= legacy[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', before LEGACY_FEE_NUMERIC_DBHITS at ' + legacy[network + '_time']);
            });
        }

        // MAINNET INVERTS THAT ORDER DELIBERATELY, and it is safe rather than tolerated.
        // The genesis arm (2026-09-09 ruling) means the legacy branch never runs for
        // SWEEP or CALLBACK on mainnet at all, so the accumulator fix LEGACY_FEE_NUMERIC_
        // DBHITS carries has nothing to correct for these two actions at any height: it
        // is not skipped, it is unreachable. Its other consumer, legacy DIVIDEND, is
        // untouched by this gate and keeps its own 2026-08-07 boundary. Pinned so a
        // future reader meets the inversion here rather than treating it as a slip.
        it('mainnet: armed BELOW the legacy accumulator fix, which the genesis arm makes moot', function(){
            const changes = pcFor('mainnet').pc.changes;
            const gate    = changes[GATE];
            const legacy  = changes['LEGACY_FEE_NUMERIC_DBHITS'];
            assert.ok(gate && legacy, 'both gates must be registered');
            assert.strictEqual(gate.mainnet_time, 0, 'the genesis arm is what makes this safe');
            assert.ok(legacy.mainnet_time > 0,
                'LEGACY_FEE_NUMERIC_DBHITS keeps its own mainnet boundary for legacy DIVIDEND');
        });

        // UNIFIED_FEES (DIVIDEND/AIRDROP and the rest) is genesis-active on every
        // network. This gate is the same model reaching the last two handlers that never
        // got a unified branch, so it can never precede it.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before UNIFIED_FEES itself', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const unified = changes['UNIFIED_FEES'];
                assert.ok(gate && unified, 'both gates must be registered');
                assert.ok(gate[network + '_time'] >= unified[network + '_time'],
                    GATE + ' must not activate before UNIFIED_FEES on ' + network);
            });
        }
    });
});
