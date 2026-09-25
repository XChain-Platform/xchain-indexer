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
const ed25519 = require('../../../../src/consensus/ed25519.js');
const {
    makeKeypair, signHex, buildBatch, rawMatch, rawCheckpoint, rawPrice,
    CHECKPOINT_KEYS, PRICE_KEYS
} = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

let oracleKeys, crossKeys;
function freshKeys(){
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

class PreCheckpointPriceWriterRecovery extends AnchorRecovery {
    async writeBatch(archive, report, network, anchorTxid, rewards){
        let legacy = Object.assign({}, archive);
        delete legacy.state_checkpoints;
        delete legacy.price_snapshots;
        delete legacy.price_tombstones;
        return super.writeBatch(legacy, report, network, anchorTxid, rewards);
    }
}

describe('AnchorRecovery checkpoint and price tables @regression @tier2', function(){
    beforeEach(freshKeys);

    it('uses the ABP archive key orders and only the full writer restores both tables', async function(){
        let batchPrice = rawPrice(202, 'DOGE/USD', { reference_block: 99 });
        let canonical = ed25519.buildPriceBatchPayload(202, 202, 99, [{
            round: 202, timestamp: batchPrice.block_timestamp, btcBlockHeight: batchPrice.reference_block,
            pairs: [{ coinPair: batchPrice.coin_pair, price: batchPrice.price }], admitBlocks: null
        }], 'regtest');
        let batchProof = JSON.stringify({
            batch: { first_round: 202, last_round: 202, btc_block_height: 99 },
            sigs: oracleKeys.slice(0, 3).map(key => ({ pubkey: key.pubkey, sig: signHex(key, canonical) }))
        });
        batchPrice.consensus_proof = batchProof;
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            checkpoints: [rawCheckpoint(101)],
            prices: [
                rawPrice(201, 'BTC/USD'),
                batchPrice,
                rawPrice(203, 'LTC/USD', {
                    price: null, validator_count: 0, consensus_proof: '[]', status: 'skipped',
                    source_action_index: null
                })
            ],
            tombstones: [{ round_number: 199, coin_pair: 'XCP/USD' }]
        });

        let legacyDb = memDb([batch.v1], batch.v2s);
        let legacyReport = await new PreCheckpointPriceWriterRecovery(legacyDb, quiet).run();
        assert.strictEqual(legacyReport.verified, 1);
        assert.strictEqual(legacyDb.matches.length, 1, 'the pre-change match writer still runs');
        assert.strictEqual(legacyDb.checkpoints.length, 0, 'the pre-change writer leaves state_checkpoints empty');
        assert.strictEqual(legacyDb.prices.length, 0, 'the pre-change writer leaves price_snapshots empty');

        let fullDb = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(fullDb, quiet).run();
        assert.strictEqual(report.verified, 1);
        assert.deepStrictEqual([report.checkpoints, report.prices, report.tombstones], [1, 3, 1]);
        assert.strictEqual(fullDb.checkpoints.length, 1);
        assert.strictEqual(fullDb.prices.length, 3);
        assert.deepStrictEqual(fullDb.prices.map(row => row.status), ['finalized', 'finalized', 'skipped']);

        let dryDb = memDb([batch.v1], batch.v2s);
        let dryReport = await new AnchorRecovery(dryDb, Object.assign({ dryRun: true }, quiet)).run();
        assert.deepStrictEqual([dryReport.checkpoints, dryReport.prices, dryReport.tombstones], [1, 3, 1]);
        assert.strictEqual(dryDb.checkpoints.length, 0);
        assert.strictEqual(dryDb.prices.length, 0);

        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1);
        assert.deepStrictEqual(Object.keys(archive.state_checkpoints[0]), CHECKPOINT_KEYS);
        assert.deepStrictEqual(Object.keys(archive.price_snapshots[0]), PRICE_KEYS);
        assert.deepStrictEqual(Object.keys(archive.price_tombstones[0]), ['round_number', 'coin_pair']);
    });

    it('rejects a forged checkpoint signature and writes none of the batch', async function(){
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            checkpoints: [rawCheckpoint(102)], checkpointKeys: crossKeys,
            prices: [rawPrice(202, 'BTC/USD')]
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('checkpoint'));
        assert.ok(report.failed[0].reason.includes('fails quorum'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.checkpoints.length, 0);
        assert.strictEqual(db.prices.length, 0);
    });

    it('rejects a forged signature-proofed price round and writes none of the batch', async function(){
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            checkpoints: [rawCheckpoint(103)],
            prices: [rawPrice(203, 'BTC/USD'), rawPrice(203, 'LTC/USD', { id: 204 })],
            priceSignKeys: crossKeys
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('price round'));
        assert.ok(report.failed[0].reason.includes('fails quorum'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.checkpoints.length, 0);
        assert.strictEqual(db.prices.length, 0);
    });

    it('rejects a forged disputed price proof and writes none of the batch', async function(){
        let honest = buildBatch(0, [], oracleKeys, crossKeys, {
            prices: [rawPrice(204, 'BTC/USD')]
        });
        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(honest.v1);
        let proof = JSON.parse(archive.price_snapshots[0].consensus_proof);
        proof[0].sig = '00'.repeat(64);
        let forged = buildBatch(1, [rawMatch('m1')], oracleKeys, crossKeys, {
            prices: [rawPrice(204, 'BTC/USD', {
                consensus_proof: JSON.stringify(proof), status: 'disputed'
            })]
        });
        let db = memDb([forged.v1], forged.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('price round'));
        assert.ok(report.failed[0].reason.includes('fails quorum'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.prices.length, 0);
    });

    it('rejects an object-form batch proof that lacks price quorum', async function(){
        let price = rawPrice(204, 'BTC/USD');
        let canonical = ed25519.buildPriceBatchPayload(204, 204, 100, [{
            round: 204, timestamp: price.block_timestamp, btcBlockHeight: price.reference_block,
            pairs: [{ coinPair: price.coin_pair, price: price.price }], admitBlocks: null
        }], 'regtest');
        let proof = JSON.stringify({
            batch: { first_round: 204, last_round: 204, btc_block_height: 100 },
            sigs: [{ pubkey: oracleKeys[0].pubkey, sig: signHex(oracleKeys[0], canonical) }]
        });
        price.consensus_proof = proof;
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            prices: [price]
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('price batch'));
        assert.ok(report.failed[0].reason.includes('fails quorum'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.prices.length, 0);
    });

    it('lets later batches overwrite a disputed flip and a late batch_block_time', async function(){
        let initial = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { prices: [rawPrice(204, 'BTC/USD')] });
        let initialArchive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(initial.v1);
        let proof = initialArchive.price_snapshots[0].consensus_proof;
        let disputed = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, {
            prices: [rawPrice(204, 'BTC/USD', { consensus_proof: proof, status: 'disputed' })]
        });
        let landed = buildBatch(2, [rawMatch('m3')], oracleKeys, crossKeys, {
            prices: [rawPrice(204, 'BTC/USD', {
                consensus_proof: proof, status: 'disputed', batch_block_time: 1700000999
            })]
        });
        let db = memDb([initial.v1, disputed.v1, landed.v1],
            initial.v2s.concat(disputed.v2s, landed.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 3);
        assert.strictEqual(report.prices, 3);
        assert.strictEqual(db.prices.length, 1);
        assert.strictEqual(db.prices[0].status, 'disputed');
        assert.strictEqual(db.prices[0].batch_block_time, 1700000999);
    });

    it('applies a tombstone and lets a later batch restore the republished round', async function(){
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { prices: [rawPrice(205, 'XCP/USD')] });
        let removed = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
            { tombstones: [{ round_number: 205, coin_pair: 'XCP/USD' }] });
        let restored = buildBatch(2, [rawMatch('m3')], oracleKeys, crossKeys,
            { prices: [rawPrice(205, 'XCP/USD', { price: '101.75', id: 999 })] });
        let db = memDb([first.v1, removed.v1, restored.v1],
            first.v2s.concat(removed.v2s, restored.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 3);
        assert.deepStrictEqual([report.prices, report.tombstones], [2, 1]);
        assert.strictEqual(db.prices.length, 1);
        assert.strictEqual(db.prices[0].price, '101.75');
        assert.strictEqual(db.prices[0].id, 999);
    });

    it('fails a checkpoint sequence collision with different content', async function(){
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { checkpoints: [rawCheckpoint(106)] });
        let second = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, {
            checkpoints: [rawCheckpoint(106, { id: 999, block_hash: 'aa'.repeat(32) })]
        });
        let db = memDb([first.v1, second.v1], first.v2s.concat(second.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.failed.length, 1);
        assert.ok(report.failed[0].reason.includes('collides with an existing checkpoint sequence'));
        assert.strictEqual(db.checkpoints.length, 1);
        assert.strictEqual(db.checkpoints[0].block_hash, '11'.repeat(32));
    });
});
