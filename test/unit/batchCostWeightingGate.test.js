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
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on EVERY network.
 *     Mainnet was armed at 0 by the 2026-09-09 ruling, which superseded the
 *     2026-08-20 one that had reserved it a dedicated flag day: mainnet has never
 *     carried a BATCH, so neither the budget nor the weights can move a verdict;
 *   - the ORDERING against BATCH_ISSUANCE_LIMITS, which the genesis arm INVERTS on
 *     mainnet (0 against that entry's 2026-08-16). The invariant is real - a window
 *     where the budget ran and the flat cap did not would weigh un-normalized params
 *     and leave the batch with no bound at all - so it is now pinned where it
 *     actually lives, in batch.js: every site that reads `weightsActive` sits inside
 *     an `if(limitsActive)`, so the budget cannot run without the cap. That is driven
 *     through the real handler below, not inferred from the two constants;
 *   - that 0 means GENESIS and nothing else. A nonzero past instant here would be
 *     the harmful case: a cap model that changed at a moment the fleet never
 *     observed. A future instant would be a flag day the measurement says is unneeded.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');
const Batch                 = require('../../src/actions/batch.js');

const GATE          = 'BATCH_COST_WEIGHTING';
const LIMITS        = 'BATCH_ISSUANCE_LIMITS';
const NORMALIZATION = 'BATCH_SUBACTION_NORMALIZATION';

// The house UNARMED sentinel. No slot of this gate may hold it any more.
const UNARMED_SENTINEL = 9999999999;

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

        it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling', function(){
            const instant = ProtocolChanges.BATCH_COST_WEIGHTING_MAINNET_TIME;
            assert.strictEqual(typeof instant, 'number', 'the instant must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, instant);
            // 0, and nothing else. The acceptance evidence a flag day would have bought
            // has nothing to measure: mainnet holds zero BATCHes, zero DEPLOYs, zero
            // EXECUTEs and zero fan-out actions (measured 2026-09-09), so the budget and
            // the weights are identity on every block a from-genesis replay reaches.
            assert.strictEqual(instant, 0,
                'mainnet must be armed at genesis, not at a sentinel and not at an instant');
            assert.notStrictEqual(instant, UNARMED_SENTINEL);
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

        it('mainnet: ACTIVE from block 0 and at every instant above it', async function(){
            // Includes the sibling gate's own armed instant and a decade past it: the
            // point of a genesis arm is that no reachable block time turns this off.
            for(const t of [0, 1, 1786838400, 1786838400 + 315360000]){
                const { pc, indexer } = pcFor('mainnet');
                indexer.decoderDb.getBlockTime.resolves(t);
                assert.strictEqual(await pc.isEnabled(GATE, 0), true,
                    'must be active at block_time ' + t);
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
        // isEnabled() has no notion of one change depending on another. On testnet and
        // regtest, where all three entries are genesis-active, the registered order still
        // states the dependency and is asserted here. MAINNET IS THE EXCEPTION since the
        // 2026-09-09 genesis arm put this gate BELOW both siblings, so there the same
        // invariant is driven through batch.js instead, in the block after these.
        for(const network of ['testnet','regtest']){
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
        for(const network of ['testnet','regtest']){
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

    describe('mainnet: the ordering the genesis arm inverts, driven through batch.js', function(){

        // On mainnet this gate is registered at 0 while BATCH_ISSUANCE_LIMITS is at
        // 2026-08-16 and BATCH_SUBACTION_NORMALIZATION at 2026-08-07, so the numeric
        // ordering the two blocks above assert is inverted here BY DESIGN. What makes
        // that safe is not the measurement (mainnet holds no BATCHes) but the shape of
        // batch.js: `weightsActive` is read only inside `if(limitsActive)` blocks, in
        // parse's cap check and in the aggregate gas pre-check, so the weighting gate is
        // a strict refinement of the issuance one and can never run alone. Its EFFECTIVE
        // mainnet activation is therefore still 2026-08-16.
        //
        // These cases drive that through the real handler at a mainnet block time inside
        // the inverted window. If someone lifts a weight check out of its limitsActive
        // guard, the numeric pins above will not catch it on mainnet; these will.

        // Inside the window: above normalization, below the issuance limits.
        const IN_WINDOW = 1786060800 + 1;

        // Comfortably over both the flat 250-command cap and the 250 weight budget, so
        // either bound would reject it if either bound ran.
        const OVERSIZED = 300;

        function mainnetHandler(blockTime){
            const indexer = createMockIndexer();
            indexer.config.NETWORK = 'mainnet';
            indexer.decoderDb.getBlockTime.resolves(blockTime);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            const actionsCtx = {
                config:          indexer.config,
                util:            indexer.util,
                mapper:          indexer.mapper,
                decoderDb:       indexer.decoderDb,
                indexerDb:       indexer.indexerDb,
                protocolChanges: new ProtocolChanges(indexer, '0.2.0'),
                processAction:   sinon.stub().resolves(),
                actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
            };
            return { handler: new Batch(actionsCtx), indexer, actionsCtx };
        }

        function oversizedBatch(blockTime){
            const sends = new Array(OVERSIZED).fill(
                'SEND|0|TEST|1|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM').join(';');
            return createBaseData({
                ACTION:     'BATCH',
                FORMAT:     0,
                SOURCE:     'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
                BLOCK_TIME: blockTime,
                TX_DATA:    'BATCH|0|' + sends,
            });
        }

        afterEach(function(){ sinon.restore(); });

        it('the window really is inverted: the budget is on, the flat cap is not', async function(){
            const { actionsCtx } = mainnetHandler(IN_WINDOW);
            const pc = actionsCtx.protocolChanges;
            assert.strictEqual(await pc.isEnabled(GATE, 100), true,
                GATE + ' must be on inside the window, or this block proves nothing');
            assert.strictEqual(await pc.isEnabled(LIMITS, 100), false,
                LIMITS + ' must still be off inside the window');
            assert.strictEqual(await pc.isEnabled(NORMALIZATION, 100), true);
        });

        it('a 300-command batch inside the window is admitted, so no bound ran', async function(){
            const { handler } = mainnetHandler(IN_WINDOW);
            const data = oversizedBatch(IN_WINDOW);
            await handler.parse(['0'], data, null);
            // Byte-identical to the pre-arm legacy behaviour a from-genesis replay must
            // reproduce: below BATCH_ISSUANCE_LIMITS a mainnet batch carried no command
            // bound at all, and arming the weighting gate at genesis does not give it one.
            assert.strictEqual(data['STATUS'], 'valid',
                'the weight budget ran without BATCH_ISSUANCE_LIMITS; it is no longer nested under it');
        });

        it('the same batch above BATCH_ISSUANCE_LIMITS is rejected, so the budget does bind', async function(){
            // The negative control for the case above: once the issuance gate is on, the
            // weight budget is reachable and an oversized batch is refused. Without this
            // the previous case would also pass if the budget had been deleted outright.
            const above = 1786838400 + 1;
            const { handler } = mainnetHandler(above);
            const data = oversizedBatch(above);
            await handler.parse(['0'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
        });
    });
});
