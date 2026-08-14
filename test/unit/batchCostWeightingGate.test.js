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
 * test/unit/batchCostWeightingGate.test.js
 *
 * The flag-day gate on the weighted per-BATCH cost budget.
 *
 * One protocol change registers the whole model (the budget over per-action cost
 * weights, DEPLOY at the full budget, the ratified EXECUTE/XEXEC weight, and the
 * per-recipient fan-out weight) so a heterogeneous fleet can never run half of it:
 * two nodes disagreeing about ONE weight disagree about which sub-commands ran.
 *
 * This suite pins the three things nothing else can catch:
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on testnet and
 *     regtest, mainnet on the UNARMED sentinel. It is deliberately NOT folded into
 *     BATCH_ISSUANCE_LIMITS, which arms 2026-08-16; see the constant's own comment;
 *   - the ORDERING against BATCH_ISSUANCE_LIMITS. The budget check REPLACES that
 *     entry's command cap in the same position and reuses its sub-command
 *     classification, so a window where this is live and that is not would weigh
 *     un-normalized params and would leave the batch with no bound at all in the gap;
 *   - that the sentinel is a SENTINEL. An armed-looking real date here means somebody
 *     armed a consensus cap-model replacement without the acceptance evidence, which
 *     is exactly the act this spec's Timing section refuses to rush.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

const GATE          = 'BATCH_COST_WEIGHTING';
const LIMITS        = 'BATCH_ISSUANCE_LIMITS';
const NORMALIZATION = 'BATCH_SUBACTION_NORMALIZATION';

// The house UNARMED sentinel used across this file for a change whose remedy is ruled
// but whose activation instant is a separate, deliberate operator act.
const UNARMED_SENTINEL = 9999999999;

// A far-future instant no real chain reaches before the operator arms the gate
// deliberately: 2100-01-01, the same boundary the sibling unarmed-gate suites use
// to tell a scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '0.2.0'), indexer };
}

describe('BATCH cost-weighting flag day @regression @tier1', function(){

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

        it('mainnet is UNARMED on the house sentinel, not a scheduled date', function(){
            const instant = ProtocolChanges.BATCH_COST_WEIGHTING_MAINNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, instant);
            // Arming this is an operator act that requires the acceptance evidence the
            // spec lists (a measured no-op over a real corpus, a from-genesis replay with
            // a negative control, and the ratified EXECUTE weight). A real date appearing
            // here means that act happened; if it happened deliberately, flip this pin in
            // the same commit rather than deleting it, the way the sibling gate did.
            assert.strictEqual(instant, UNARMED_SENTINEL,
                'mainnet must stay on the UNARMED sentinel until the operator arms it');
            assert.ok(instant >= YEAR_2100,
                'a value below the house sentinel reads as a scheduled activation');
        });

        it('regtest: active from genesis, so drills and suites run the post-flag-day rules', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('testnet: active from genesis', async function(){
            const { pc, indexer } = pcFor('testnet');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('mainnet: inert at every instant a real chain reaches', async function(){
            // Includes the sibling gate's own armed instant and a decade past it: the
            // whole point of the sentinel is that no reachable block time turns this on.
            for(const t of [1, 1786838400, 1786838400 + 315360000, UNARMED_SENTINEL - 1]){
                const { pc, indexer } = pcFor('mainnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 1000000), false,
                    'must be inert at block_time ' + t);
            }
        });
    });

    describe('ordering against BATCH_ISSUANCE_LIMITS', function(){

        // The dependency is real code, not bookkeeping, and it runs in both directions:
        //
        //  - the budget check REPLACES the flat command cap and stands in the same
        //    position (first in parse(), because it is the only bound on the O(N) scans
        //    behind it). A window where this gate is live and that one is not would leave
        //    the batch with NO bound at all, which is worse than either rule alone;
        //  - weighing a sub-command means classifying it, and classification reads the
        //    ACTION and the TICK out of NORMALIZED params, which is what the earlier gates
        //    establish. Below them params[1] is not the TICK for legacy-format sub-actions.
        //
        // isEnabled() has no notion of one change depending on another, so the ordering
        // lives here or nowhere.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before the issuance limits it replaces', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const limits  = changes[LIMITS];
                assert.ok(gate, GATE + ' must be registered');
                assert.ok(limits, LIMITS + ' must be registered');
                assert.ok(gate[network + '_time'] >= limits[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', BEFORE ' + LIMITS + ' at ' + limits[network + '_time'] +
                    '; the batch would be left with no command bound at all in the gap');
                assert.ok(gate[network + '_block'] >= limits[network + '_block'],
                    GATE + ' must not be height-gated below ' + LIMITS + ' on ' + network);
            });
        }

        // Transitive through BATCH_ISSUANCE_LIMITS today, asserted directly anyway: the
        // weight scan reads the same normalized params the classification does, and a
        // future re-registration of either sibling must not be able to break this quietly.
        for(const network of ['mainnet','testnet','regtest']){
            it(network + ': never activates before sub-action normalization', function(){
                const changes = pcFor(network).pc.changes;
                const gate    = changes[GATE];
                const norm    = changes[NORMALIZATION];
                assert.ok(norm, NORMALIZATION + ' must be registered');
                assert.ok(gate[network + '_time'] >= norm[network + '_time'],
                    GATE + ' activates at ' + gate[network + '_time'] + ' on ' + network +
                    ', BEFORE ' + NORMALIZATION + ' at ' + norm[network + '_time'] +
                    '; the weight scan would read un-normalized params');
                assert.ok(gate[network + '_block'] >= norm[network + '_block'],
                    GATE + ' must not be height-gated below ' + NORMALIZATION + ' on ' + network);
            });
        }
    });
});
