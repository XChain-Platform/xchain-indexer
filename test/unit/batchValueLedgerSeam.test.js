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
 * test/unit/batchValueLedgerSeam.test.js
 *
 * The SEAM between batch.js and the shared value validators.
 *
 * The batch-cumulative accounting has two halves that live in different files:
 * batch.js SEEDS data['BATCH_VALUE_LEDGER'] before its baseKeys snapshot, and the
 * shared validators in utility.js CONSUME it. Each half has its own unit suite
 * (batch.test.js, nativeFeeBatchLedger.test.js, batchSettlementValueLedger.test.js)
 * and each passes with the other half absent, because each stubs what it does not own.
 *
 * The property that matters is the one neither can see: that the object seeded in
 * batch.js is still there, still accumulating, after the dispatch loop's per-command
 * field-clearing pass has run between sub-commands. Seed it one line later, after the
 * snapshot, and every per-file suite stays green while the ledger is deleted before the
 * second sub-command runs - the original defect wearing a ledger. This suite runs the
 * REAL Batch handler over a real multi-command BATCH with the REAL validateNativeCoinFee
 * as its sub-command, so that line cannot move undetected.
 *
 * It also pins the replay half: with the flag off, no ledger is seeded and the ORIGINAL
 * defect must still reproduce exactly (one fee output satisfying all N sub-commands),
 * because a from-genesis replay has to reach the same verdicts the live chains did.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');

const Batch   = require('../../src/actions/batch.js');
const Utility = require('../../src/utility.js');

const FEE_DEST = 'bcrt1qfeedestination';

// Oracle pinned so the fee band is deterministic: 1 XCHAIN = $1 and 1 BTC = $100, so a
// 1 XCHAIN fee expects 0.01 BTC and accepts down to 0.0095 (the 0.95 tolerance floor).
const ONE_FEE = '0.01';

function makeUtil(){
    const util = new Utility({ config: {}, util: null });
    util.config = {
        ADDRESS:                     { FEE_DESTINATION: FEE_DEST },
        FEE_TOLERANCE_MIN:           '0.95',
        FEE_TOLERANCE_MAX:           '1.10',
        COIN:                        'BTC',
        ORACLE_MAX_PRICE_AGE_SECONDS:'1800',
    };
    util.getFeeOraclePrices = async () => ({
        coinUsdPrice:   util.bcnum('100'),
        xchainUsdPrice: util.bcnum('1'),
        oracleRound:    7,
    });
    return util;
}

// Drive a BATCH of `count` fee-bearing sub-commands against a single fee output holding
// `feeValue`, with the flag on or off. Returns each sub-command's verdict plus the `data`
// object the loop finished with.
async function runBatch({ count, feeValue, flagOn }){
    const util    = makeUtil();
    const results = [];

    const actions = {
        actionAliases:   {},
        protocolChanges: { isEnabled: async () => true },
        async processAction(action, params, data){
            const res = await util.validateNativeCoinFee(data, { AMOUNT: '1' }, null, data['TX_OUTPUTS']);
            results.push({ position: data['BATCH_POSITION'], valid: res.valid, amount: res.nativeCoinAmount });
            // A real handler leaves action-specific fields behind. The clear pass must drop
            // these while preserving the ledger sitting beside them.
            data['ACTION_SPECIFIC_JUNK'] = 'from ' + data['BATCH_POSITION'];
            data['FORMAT'] = 99;
        },
    };

    const batch = new Batch({
        config:          util.config,
        decoderDb:       null,
        util,
        mapper:          { createMappings: async () => {} },
        actionAliases:   {},
        protocolChanges: { isEnabled: async (name) => flagOn || name !== 'BATCH_ISSUANCE_LIMITS' },
        indexerDb: {
            createBatch:       async () => {},
            isActionAllowed:   async () => true,
            createActionIndex: async (d) => 1000 + d['BATCH_POSITION'],
        },
    });
    batch.actions = actions;

    const data = {
        SOURCE:     'bcrt1qsource',
        FORMAT:     0,
        BLOCK_INDEX: 500,
        BLOCK_TIME:  1786060900,
        TX_DATA:    'BATCH|0|' + Array.from({ length: count }, (_, i) => 'ORDER|0|c' + i).join(';'),
        TX_OUTPUTS: [{ address: FEE_DEST, value: feeValue }],
    };
    await batch.parse([], data, false);
    return { results, data };
}

describe('BATCH value-ledger seam @regression @tier1', function(){

    describe('flag ON: the ledger survives the per-command field clear', function(){

        it('one command\'s worth of fee validates exactly ONE of three sub-commands', async function(){
            const { results, data } = await runBatch({ count: 3, feeValue: ONE_FEE, flagOn: true });
            assert.strictEqual(data['STATUS'], 'valid', 'the BATCH itself is well formed');
            assert.strictEqual(results.length, 3, 'every sub-command must still run');
            assert.strictEqual(results.filter(r => r.valid).length, 1,
                'one fee output must fund exactly one sub-command, never all three');
            assert.strictEqual(results[0].valid, true, 'the first sub-command is the funded one');
            assert.strictEqual(results[0].amount, '0.01000000');
        });

        it('keeps the ledger on `data` after the clear pass, still accumulating as strings', async function(){
            const { data } = await runBatch({ count: 3, feeValue: ONE_FEE, flagOn: true });
            const ledger = data['BATCH_VALUE_LEDGER'];
            assert.ok(ledger && typeof ledger === 'object',
                'the ledger must be seeded BEFORE the baseKeys snapshot or the clear pass deletes it');
            assert.strictEqual(ledger.nativeFeeConsumed, '0.01000000');
            assert.strictEqual(typeof ledger.nativeFeeConsumed, 'string',
                'tallies are decimal strings, never JS numbers');
            assert.strictEqual(typeof ledger.oracleFeeConsumed, 'object',
                'the per-oracle map travels with it');
        });

        it('clears action-specific fields between sub-commands while preserving the ledger', async function(){
            const { data } = await runBatch({ count: 3, feeValue: ONE_FEE, flagOn: true });
            // The clear runs at the TOP of each iteration, so the LAST sub-command's field
            // legitimately survives the loop. That it is the last one's and not the first's
            // is what proves each iteration cleared its predecessor - with the ledger,
            // seeded beside those fields, surviving all of them.
            assert.strictEqual(data['ACTION_SPECIFIC_JUNK'], 'from 2');
            assert.ok(data['BATCH_VALUE_LEDGER'], 'the ledger outlives every clear');
        });

        it('three commands\' worth funds exactly three of four, never a fourth', async function(){
            const { results, data } = await runBatch({ count: 4, feeValue: '0.03', flagOn: true });
            assert.strictEqual(results.filter(r => r.valid).length, 3);
            assert.strictEqual(results[3].valid, false, 'the fourth draws on an exhausted pool');
            assert.strictEqual(data['BATCH_VALUE_LEDGER'].nativeFeeConsumed, '0.03000000');
        });
    });

    describe('flag OFF: the original defect must replay byte-identically', function(){

        it('seeds no ledger at all', async function(){
            const { data } = await runBatch({ count: 3, feeValue: ONE_FEE, flagOn: false });
            assert.strictEqual(data['BATCH_VALUE_LEDGER'], undefined);
        });

        it('still lets ONE fee output satisfy all three sub-commands', async function(){
            // This is the bug. It is also consensus history: every pre-flag-day BATCH on a
            // live chain was judged this way, so a from-genesis replay must reach the same
            // verdicts. A "fix" that also changed the pre-flag path would fork the ledger.
            const { results } = await runBatch({ count: 3, feeValue: ONE_FEE, flagOn: false });
            assert.strictEqual(results.filter(r => r.valid).length, 3);
            assert.strictEqual(results[2].amount, '0.01000000',
                'each sub-command saw the FULL untouched output, exactly as it always did');
        });
    });
});
