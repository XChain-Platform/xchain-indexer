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
 * Integration: a SLASH that lands in the post-UNSTAKE activation-delay window must
 * burn the bond EXACTLY ONCE (real DB + real VM).
 *
 * UNSTAKE v0 leaves the `stakes` row's amount intact and only sets a FUTURE
 * deactivation_block (= unstake_block + ACTIVATION_DELAY_BLOCKS), mirroring the bond
 * into a cooldown `unstakes` row. slashCapabilityStake must therefore burn the
 * cooldown copy (Pass 2) ONLY and skip the still-"active" stakes phantom (Pass 1),
 * or the bond is burned twice: totalSlashed = 2×bond, inflating the bounty/treasury
 * base and (on the contract path) refunding the staker in full despite the slash.
 *
 * REGRESSION: Pass 1 filtered `deactivation_block IS NULL OR deactivation_block > ?`.
 * Because deactivation_block is in the FUTURE, that predicate is TRUE throughout the
 * [unstake, unstake+delay) window, so Pass 1 burned the stakes row AND Pass 2 burned
 * the unstakes row → a 6000 bond slashed as 12000. Fix: Pass 1 filters
 * `deactivation_block IS NULL`, so a mid-cooldown slash hits ONLY the cooldown row.
 *
 * This drives a real Ed25519 equivocation proof through the real indexer with an
 * UNSTAKE seeded between STAKE and SLASH so the slash lands inside the window, and
 * asserts the burn is single-counted.
 *
 * Run (disposable MariaDB, e.g. the integration venue):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_sm_decoder TEST_INDEXER_DB=cv_sm_indexer TEST_INDEXER_DB_B=cv_sm_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/24-slash-mid-cooldown-double-count.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const eq = require('../../../src/equivocation_header.js');
const srb = require('../../../src/snapshot_reorg_buffer.js');

const FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // configs/BTC.js ADDRESS.GAS (fee-exempt gas funder)
const A1     = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // valid regtest P2PKH (the staker)
const T = 1700000000;

const STAKE_BLOCK   = 100;
const ACTIVE_BLOCK  = 106;   // STAKE_BLOCK + BTC activation delay (6): the bond is active here
// The RAW snapshot_block the proof declares. The verifier resolves the set at
// buriedSnapshotBlock(SNAP) = ACTIVE_BLOCK, which is where the hub that locked the slot
// resolved its own signer set, so a declared height a real proof could carry sits a
// CANONICAL_REORG_BUFFER above the block the bond has to be active at.
const SNAP          = ACTIVE_BLOCK + srb.CANONICAL_REORG_BUFFER;   // 112
const UNSTAKE_BLOCK = 113;   // unstake after activation => deactivation_block = 119
const SLASH_BLOCK   = 115;   // inside [113, 119): the slash lands mid-cooldown (the bug window)
const STAKE_AMT     = '6000'; // > cross_chain MIN_STAKE (5000)

function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubHex: Buffer.from(der.slice(-32)).toString('hex') };
}
const sign = (priv, msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), priv).toString('hex');
const b64  = (s) => Buffer.from(s, 'utf8').toString('base64url');

async function seedGasRich(seeder) {
    await seeder.seedBlock(99, T - 600, [
        { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap', txHash: 'd'.repeat(56) + '00000001' },
        { source: A1,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'd'.repeat(56) + '00000002' },
    ]);
}

// XMATCH (XDEX) raw canonical: snapshot_block is field index 2 (mirrors scenario 17).
function dexContent(snap, aAmount) {
    return ['XMATCH', 'm_1', String(snap),
            'BTC', '1', 'TICKA', String(aAmount), '0', 'addrA',
            'LTC', '2', 'TICKB', '5', '0', 'addrB',
            String(T), 'regtest', 'swap', '0', 'swap', '0'].join('|');
}

describe('Integration: SLASH mid-cooldown must burn the bond once (real DB + real VM) @regression @tier1', function () {
    this.timeout(120000);

    let offender, run;

    function slashAction() {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '10'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '20'));
        return ['SLASH', '0', 'cross_chain', offender.pubHex,
                b64(msgA), sign(offender.privateKey, msgA),
                b64(msgB), sign(offender.privateKey, msgB)].join('|');
    }

    async function runCorpus() {
        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasRich(seeder);
        // STAKE -> UNSTAKE (schedules cooldown, sets a FUTURE deactivation_block) -> SLASH in-window.
        await seeder.seedBlock(STAKE_BLOCK,   T,       [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);
        await seeder.seedBlock(UNSTAKE_BLOCK, T + 700, [{ source: A1, data: 'UNSTAKE|0|' + offender.pubHex }]);
        await seeder.seedBlock(SLASH_BLOCK,   T + 1000, [{ source: A1, data: slashAction() }]);

        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const chain = await indexerQuery(
                `SELECT b.block_index, t1.hash AS ledger, t2.hash AS actions
                 FROM blocks b
                 LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
                 LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
                 ORDER BY b.block_index ASC`);
            const stakeRows   = await indexerQuery(
                `SELECT s.amount, s.deactivation_block FROM stakes s
                 JOIN index_pubkeys p ON p.id = s.signing_pubkey_id WHERE p.pubkey = ?`, [offender.pubHex]);
            const unstakeRows = await indexerQuery(
                `SELECT u.amount FROM unstakes u
                 JOIN index_pubkeys p ON p.id = u.signing_pubkey_id WHERE p.pubkey = ?`, [offender.pubHex]);
            const events = await indexerQuery(`SELECT capability, amount FROM capability_slash_events`);
            const debits = await indexerQuery(
                `SELECT target_table, prev_amount FROM capability_slash_debits ORDER BY id`);
            return {
                chain: chain.map(r => ({ block_index: Number(r.block_index), ledger: r.ledger, actions: r.actions })),
                stakeAmounts:   stakeRows.map(r => String(r.amount)),
                deactivation:   stakeRows.map(r => (r.deactivation_block == null ? null : Number(r.deactivation_block))),
                unstakeAmounts: unstakeRows.map(r => String(r.amount)),
                events, debits,
            };
        } finally {
            await destroyIndexer(indexer);
        }
    }

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        offender = genKey();
        await createDatabases(__filename);
        await createDecoderSchema();
        run = await runCorpus();
    });

    after(async function () { await destroyFileIndexers(__filename); await closeAll(); });

    it('the slash landed inside the post-unstake activation-delay window (setup sanity)', function () {
        // The proof's set resolves at the buried height, which must land on the activation
        // block and inside the bond's active window, or the SLASH never reaches the burn
        // this scenario is about and the whole file passes vacuously.
        const resolved = srb.buriedSnapshotBlock(SNAP, 'regtest');
        assert.strictEqual(resolved, ACTIVE_BLOCK,
            'the declared snapshot_block must bury onto the activation block');
        assert.ok(resolved < UNSTAKE_BLOCK,
            'the offender must still be in the set at the resolved height, or nothing is burned');
        // Exactly one stakes row, carrying a FUTURE deactivation_block > SLASH_BLOCK: this is the
        // condition that made the old `deactivation_block > ?` Pass-1 filter wrongly include it.
        assert.strictEqual(run.deactivation.length, 1, 'one stakes row for the offender');
        assert.ok(run.deactivation[0] !== null && run.deactivation[0] > SLASH_BLOCK,
            'stakes row must carry a future deactivation_block (> slash block ' + SLASH_BLOCK + '), got ' + run.deactivation[0]);
    });

    it('burns the bond EXACTLY ONCE: slash event == bond (not 2×), single unstakes debit', function () {
        // The core regression. Pre-fix: Pass 1 burns the stakes phantom AND Pass 2 burns the
        // cooldown row => event amount = 12000 and two debits. Post-fix: one burn of 6000.
        assert.strictEqual(run.events.length, 1, 'exactly one slash event');
        assert.strictEqual(Number(run.events[0].amount), Number(STAKE_AMT),
            'the slash must burn exactly the bond (' + STAKE_AMT + '), not double it (got ' + run.events[0].amount + ')');
        assert.strictEqual(run.debits.length, 1, 'exactly one in-place slash debit (the cooldown row only)');
        assert.strictEqual(run.debits[0].target_table, 'unstakes',
            'the mid-cooldown burn must debit the contract cooldown row (unstakes), never the stakes phantom');
        assert.strictEqual(Number(run.debits[0].prev_amount), Number(STAKE_AMT),
            'the debit records the verbatim pre-slash cooldown amount');
    });

    it('the stakes phantom is left untouched; the cooldown row is zeroed', function () {
        // The stakes row (the phantom) keeps its amount; only the unstakes cooldown row is burned to 0.
        for (const a of run.stakeAmounts)
            assert.strictEqual(Number(a), Number(STAKE_AMT),
                'the stakes phantom must NOT be burned (it was already mirrored into the cooldown row)');
        for (const a of run.unstakeAmounts)
            assert.strictEqual(Number(a), 0, 'the cooldown unstakes row is burned to 0');
    });

    it('re-deriving from a clean DB yields the IDENTICAL hash chain (determinism = no fork)', async function () {
        const second = await runCorpus();
        assert.deepStrictEqual(second.chain, run.chain,
            'mid-cooldown SLASH produced different consensus hashes for the same input (fork risk)');
        assert.deepStrictEqual(second.events, run.events);
        assert.deepStrictEqual(second.debits, run.debits);
    });
});
