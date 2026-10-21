'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');
const { UNSIGNED_PRICE_DEFAULTS } = require('../../../../bin/recovery/checkpoint_price.js');
const { makeKeypair, buildBatch, rawMatch, rawPrice } = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

const quiet = { log: () => {}, util };
const FORGED = { source_chain: 'LTC', source_action_index: 999999, batch_block_time: 1999999999 };

describe('recovery: unsigned price columns are not proven by the archive', function(){
    let oracleKeys, crossKeys;
    beforeEach(function(){
        oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    });

    it('re-derives forged source_chain, source_action_index and batch_block_time to the defaults', async function(){
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            prices: [rawPrice(301, 'BTC/USD', FORGED), rawPrice(302, 'LTC/USD', FORGED)]
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, 'signed fields still verify');
        assert.strictEqual(db.prices.length, 2);
        for(let row of db.prices){
            assert.strictEqual(row.source_chain, UNSIGNED_PRICE_DEFAULTS.source_chain);
            assert.strictEqual(row.source_action_index, null, 'no forged retraction key');
            assert.strictEqual(row.batch_block_time, 0, 'no forged landing clock');
        }
    });

    it('does not let a forged row overwrite an existing row with its unsigned columns', async function(){
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { prices: [rawPrice(303, 'BTC/USD')] });
        let second = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
            { prices: [rawPrice(303, 'BTC/USD', FORGED)] });
        let db = memDb([first.v1, second.v1], first.v2s.concat(second.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(db.prices.length, 1);
        assert.strictEqual(db.prices[0].source_action_index, null);
        assert.strictEqual(db.prices[0].batch_block_time, 0);
        assert.strictEqual(db.prices[0].source_chain, UNSIGNED_PRICE_DEFAULTS.source_chain);
    });

    it('ignores malformed unsigned columns instead of treating them as proof or rejecting the batch', async function(){
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            prices: [rawPrice(304, 'BTC/USD', { source_chain: '', source_action_index: 'x', batch_block_time: -5 })]
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1);
        assert.strictEqual(db.prices[0].batch_block_time, 0);
        assert.strictEqual(db.prices[0].source_action_index, null);
    });
});
