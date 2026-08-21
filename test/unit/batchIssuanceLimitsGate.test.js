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
 * test/unit/batchIssuanceLimitsGate.test.js
 *
 * The flag-day gate on the BATCH issuance-limits rework.
 *
 * One protocol change registers the whole set (dotted-TICK exemption, the global
 * 250-command cap, batch-cumulative fee/settlement accounting, the caret-TICK and
 * ticker-intern tightenings) so a heterogeneous fleet can never run half of it.
 *
 * This suite pins the things nothing else can catch:
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on testnet and
 *     regtest, mainnet ARMED at 1786838400 (2026-08-16T00:00:00Z, armed by the
 *     operator 2026-08-14, pre-launch). The set carries a loosening AND several
 *     tightenings at once, so a guessed or moved instant forks a from-genesis
 *     replay in both directions;
 *   - the ORDERING against BATCH_SUBACTION_NORMALIZATION. Classification reads the
 *     TICK out of NORMALIZED sub-command params (params[1]); below the normalization
 *     flag a legacy-format sub-action has not had its implied VERSION 0 injected, so
 *     params[1] is not the TICK and every classification is wrong. isEnabled() has no
 *     notion of one change depending on another, so the ordering lives here or nowhere;
 *   - the EQUALITY with the decoder's BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION. The
 *     canonical map states the two as one boundary; this is the indexer half of that
 *     guard, so a one-sided move made in THIS repo fails here, not only in decoder CI.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

// The decoder's vendored activation map, the other half of the one-boundary contract.
// A plain zero-dependency constants file, so it is required straight off disk; skips
// when the sibling checkout is absent unless XCHAIN_REQUIRE_SIBLINGS=1 (CI) hard-fails.
const DECODER_CONSTANTS = process.env.XCHAIN_DECODER_DIR
    ? path.join(process.env.XCHAIN_DECODER_DIR, 'src', 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-decoder', 'src', 'protocol', 'constants.js');

const GATE          = 'BATCH_ISSUANCE_LIMITS';
const NORMALIZATION = 'BATCH_SUBACTION_NORMALIZATION';
const FANOUT        = 'FIX_OUTPUT_FANOUT';

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the same boundary the sibling unarmed-gate suites use
// to tell a scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

// The ratified mainnet activation instant, ARMED 2026-08-14 by the operator, pre-launch.
// 1786838400 = 2026-08-16T00:00:00Z. ARMED_AT is the moment it was armed (2026-08-14T00:00Z,
// floored to the day so this pin never drifts): the instant must sit strictly after it,
// because a retroactive boundary forks a from-genesis replay in both directions at once.
const ARMED_INSTANT = 1786838400;
const ARMED_AT      = 1786665600;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '0.2.0'), indexer };
}

describe('BATCH issuance-limits flag day @regression @tier1', function(){

    describe('registration', function(){

        it('is a time-keyed 2.0.0 change, genesis-active on testnet and regtest', function(){
            const change = pcFor('regtest').pc.changes[GATE];
            assert.ok(change, GATE + ' must be registered');
            assert.strictEqual(change.version_major, 0);
            assert.strictEqual(change.version_minor, 2);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed: BATCH runs on BTC, LTC and DOGE, whose heights diverge by
            // millions of blocks, so no single height names one cutover across all three.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
        });

        it('mainnet is ARMED at the ratified instant, and it is a real date rather than a sentinel', function(){
            const instant = ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, instant);
            // ARMED 2026-08-14 (operator, pre-launch). This used to assert the opposite - that
            // the value stayed a far-future UNARMED sentinel - and flipping it is the whole
            // point of the arming, so the pin flips with it rather than being deleted.
            assert.strictEqual(instant, ARMED_INSTANT,
                'the mainnet arm is a ratified instant; changing it is a consensus act, not a tidy-up');
            assert.ok(instant < YEAR_2100,
                'a value at or past the house sentinel means the arm was reverted or re-parked');
        });

        it('the armed instant was in the FUTURE when it was set, never retroactive', function(){
            // The property that outlives the date. This entry carries a loosening AND several
            // tightenings, so a backdated boundary forks a from-genesis replay in BOTH
            // directions: it would reject batches the chain accepted and accept batches it
            // rejected. Pre-launch quiet does not make that safe, it only makes it unnoticed.
            // ARMED_AT is when the operator set it; the instant must sit after that moment.
            // Read the LIVE source constant, not the local pin: comparing two test constants
            // would be tautological and would stay green while somebody backdated the real
            // one. Caught by falsification - the first cut of this test did exactly that.
            const live = ProtocolChanges.BATCH_ISSUANCE_LIMITS_MAINNET_TIME;
            assert.ok(live > ARMED_AT,
                'the activation instant must be later than the moment it was armed, got ' + live);
        });

        it('regtest: active from genesis, so drills and suites run the post-flag-day rules', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('mainnet: inert BELOW the instant, so history before it is untouched', async function(){
            const { pc, indexer } = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(ARMED_INSTANT - 1);
            assert.strictEqual(await pc.isEnabled(GATE, 1000000), false);
        });

        it('mainnet: live AT and ABOVE the instant', async function(){
            for(const t of [ARMED_INSTANT, ARMED_INSTANT + 1, YEAR_2100]){
                const { pc, indexer } = pcFor('mainnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 1000000), true,
                    'must be active at block_time ' + t);
            }
        });
    });

    describe('ordering against BATCH_SUBACTION_NORMALIZATION', function(){

        // The dependency is real code, not bookkeeping: the limit scan classifies an ISSUE
        // by params[1], which is only the TICK once normalizeSubAction has injected the
        // implied legacy VERSION 0. A window where this gate is live and normalization is
        // not would classify legacy-format sub-commands off the wrong field.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before normalization', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const norm    = changes[NORMALIZATION];
                assert.ok(gate, GATE + ' must be registered');
                assert.ok(norm, NORMALIZATION + ' must be registered');
                assert.ok(gate[network + '_time'] >= norm[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', BEFORE ' + NORMALIZATION + ' at ' + norm[network + '_time'] +
                    '; the limit scan would classify un-normalized params');
                assert.ok(gate[network + '_block'] >= norm[network + '_block'],
                    GATE + ' must not be height-gated below ' + NORMALIZATION + ' on ' + network);
            });
        }
    });

    describe('ordering against FIX_OUTPUT_FANOUT', function(){

        // A batched COINPAY is a DATA-BEARING transaction carrying SEVERAL payment
        // outputs, one per payee (src/actions/coinpay.js resolves each obligation
        // against its own output). Below FIX_OUTPUT_FANOUT, collapseOutputFanout does
        // not collapse such a row - it THROWS, which halts block processing. So a
        // window where this gate is live and the fan-out fix is not does not merely
        // mis-settle: it stops the chain on the first multi-payee batch.
        //
        // The same argument binds the DECODER's own capture gate
        // (BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION, xchain-decoder), which must arm
        // at or after this one or the output set is empty and nothing settles at all.
        // That side is asserted in the decoder's own suite; this is the indexer half.
        //
        // Today's pins are safe, but by a FINITE margin now rather than a far-future
        // sentinel: FIX_OUTPUT_FANOUT mainnet 1786060800 sits 777600 s (9 days) below this gate's
        // armed 1786838400 (both genesis-active elsewhere), so re-anchoring either value
        // can break the ordering. Nothing enforced it before this block, which is the
        // same gap the normalization ordering above exists to close.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before the output-fanout fix', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const fanout  = changes[FANOUT];
                assert.ok(gate, GATE + ' must be registered');
                assert.ok(fanout, FANOUT + ' must be registered');
                assert.ok(gate[network + '_time'] >= fanout[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', BEFORE ' + FANOUT + ' at ' + fanout[network + '_time'] +
                    '; a multi-payee batched COINPAY would halt the block rather than settle');
                assert.ok(gate[network + '_block'] >= fanout[network + '_block'],
                    GATE + ' must not be height-gated below ' + FANOUT + ' on ' + network);
            });
        }
    });

    describe('equality with the decoder BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION', function(){

        // The canonical map (xchain-documentation/protocol/constants.js) states the
        // decoder's sub-command output capture and this settlement ledger as ONE decision,
        // ONE boundary: the same instant on every network. A gap in either direction is
        // a consensus window. Capture before the ledger lets N COINPAY sub-commands settle
        // N obligations from one payment; the ledger before capture makes a batched
        // COINPAY spend the coin and settle nothing, because capture still reads only the
        // top-level ACTION name. The decoder's own suite asserts the equality from its
        // side; this is the indexer half, so a move of BATCH_ISSUANCE_LIMITS made in THIS
        // repo fails in this repo's CI rather than only when decoder CI next runs.
        function decoderCaptureOrSkip(ctx){
            if (!fs.existsSync(DECODER_CONSTANTS)){
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + DECODER_CONSTANTS);
                ctx.skip();
                return null;
            }
            const map = require(DECODER_CONSTANTS).BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION;
            assert.ok(map && typeof map === 'object',
                'xchain-decoder/src/protocol/constants.js must export BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION');
            return map;
        }

        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': arms at exactly the decoder capture instant', function(){
                const capture = decoderCaptureOrSkip(this);
                if (capture === null) return;
                const ledger = pcFor(network).pc.changes[GATE][network + '_time'];
                if (capture[network] === null){
                    // A DISARMED decoder gate may only sit under a DISARMED ledger.
                    assert.ok(ledger >= YEAR_2100,
                        GATE + ' is armed at ' + ledger + ' on ' + network + ' while the decoder ' +
                        'capture gate is disarmed (null): the ledger would run with capture reading ' +
                        'only the top-level ACTION name, so a batched COINPAY spends and settles nothing');
                    return;
                }
                assert.strictEqual(ledger, capture[network],
                    GATE + ' activates at ' + ledger + ' on ' + network + ' but the decoder ' +
                    'BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION is ' + capture[network] +
                    '; the canonical map states them as one boundary, and the window between ' +
                    'them either double-settles one payment or settles nothing from it');
            });
        }
    });
});
