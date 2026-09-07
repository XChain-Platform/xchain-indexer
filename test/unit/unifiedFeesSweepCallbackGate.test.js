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
 *   - that BOTH mainnet AND testnet stay on the UNARMED sentinel. Testnet is the
 *     unusual half. Every other time-keyed gate in protocol_changes.js is
 *     genesis-active there because it was registered while testnet was a scratch
 *     venue carrying no history to reinterpret. Testnet went PUBLIC on 2026-09-01,
 *     so a genesis arm would re-price every SWEEP and CALLBACK already committed
 *     and fork every synced testnet node against a fresh reindex. An armed-looking
 *     real date in either slot means somebody armed a consensus fee change; if that
 *     was deliberate, flip the pin here in the same commit rather than deleting it;
 *   - that neither instant is ever BACKDATED. An activation already past is not a
 *     flag day: the fleet applies the legacy price beyond it while a from-genesis
 *     replay applies the new one, and the two diverge at the first comparison.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

const GATE = 'UNIFIED_FEES_SWEEP_CALLBACK';

// The house UNARMED sentinel for a change whose remedy is ruled but whose activation
// instant is a separate, deliberate operator act.
const UNARMED_SENTINEL = 9999999999;

// A far-future instant no real chain reaches, the boundary the sibling unarmed-gate
// suites use to tell a scheduled date from a sentinel.
const YEAR_2100 = 4102444800;

// The public testnet launch. Nothing may arm this gate at or before it.
const TESTNET_LAUNCH = 1788220800; // 2026-09-01T00:00:00Z

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

        it('mainnet is UNARMED on the house sentinel, not a scheduled date', function(){
            const instant = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, instant);
            assert.strictEqual(instant, UNARMED_SENTINEL,
                'mainnet must stay on the UNARMED sentinel until the operator arms it');
            assert.ok(instant >= YEAR_2100,
                'a value below the house sentinel reads as a scheduled activation');
        });

        it('testnet is UNARMED too, because testnet is a live public ledger', function(){
            const instant = ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('testnet').pc.changes[GATE].testnet_time, instant);
            assert.notStrictEqual(instant, 0,
                'a genesis testnet arm re-prices SWEEPs and CALLBACKs already committed on the ' +
                'public testnet and forks every synced node against a fresh reindex');
            assert.ok(instant > TESTNET_LAUNCH,
                'the testnet instant must be after the public launch, never inside committed history');
        });

        it('neither instant is ever backdated', function(){
            // An activation already in the past is not a flag day at all. This is a
            // wall-clock assertion on purpose: it starts failing the moment a pinned
            // instant lapses, which is exactly when it must be re-pinned forward.
            const now = Math.floor(Date.now() / 1000);
            for(const [network, instant] of [
                ['mainnet', ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME],
                ['testnet', ProtocolChanges.UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME],
            ]){
                assert.ok(instant > now,
                    network + ' instant ' + instant + ' has lapsed: re-pin it forward, or the ' +
                    'live fleet applies the legacy price past it while a replay applies the new one');
            }
        });

        it('regtest: active from genesis, so suites and venues run the unified price', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('mainnet and testnet: inert at every instant a real chain reaches', async function(){
            for(const network of ['mainnet','testnet']){
                for(const t of [1, TESTNET_LAUNCH, TESTNET_LAUNCH + 315360000, UNARMED_SENTINEL - 1]){
                    const { pc, indexer } = pcFor(network);
                    indexer.decoderDb.getBlockTime.resolves(t);
                    assert.strictEqual(await pc.isEnabled(GATE, 1000000), false,
                        network + ' must be inert at block_time ' + t);
                }
            }
        });
    });

    describe('relationship to the fee gates it sits beside', function(){

        // LEGACY_FEE_NUMERIC_DBHITS only has meaning while the legacy branch is still
        // the one running. Arming this gate BELOW it would switch SWEEP and CALLBACK to
        // the unified price before the legacy accumulator's own correction ever applied
        // to them, which is harmless for those two but makes the recorded activation
        // order a lie for anyone replaying it. Assert the ordering rather than trusting
        // that nobody re-registers either entry.
        for(const network of ['mainnet','testnet','regtest']){
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
