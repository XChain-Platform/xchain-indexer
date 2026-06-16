/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration: LIVE SLASH equivocation drill + cross-node determinism (WI-2 bump 2).
 *
 * Drives a real equivocation end-to-end through the REAL indexer against a real DB:
 *   1. STAKE a validator's capability bond (6000 XCHAIN → qualifies for cross_chain,
 *      MIN_STAKE 5000) from the gas funder (the bootstrap MINT caps at 1000/addr).
 *   2. The validator EQUIVOCATES — signs two conflicting XMATCH (XDEX) canonicals for
 *      the same (engine, round, view), EQUIV-headered (regtest activates the header at
 *      genesis). Real Ed25519, deterministic so both determinism runs are byte-equal.
 *   3. A permissionless SLASH|0 wire action carries the two messages + sigs.
 *   4. Assert the indexer BURNS the whole bond, writes the capability_slash_event +
 *      verbatim debit, and (the consensus property) re-deriving from a clean DB yields
 *      the IDENTICAL chained block hashes — non-determinism here = a fork.
 *
 * Mirrors the harness of 10-determinism-baseline. Needs a disposable MariaDB (TEST_DB_*).
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const eq = require('../../../src/equivocation_header.js');

// The regtest gas funder (configs/BTC.js ADDRESS.GAS) holds the full bootstrap supply,
// so it can fund a >MIN_STAKE bond (the per-address seedGas MINT caps at 1000).
const FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';
const A1     = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const T = 1700000000;

const STAKE_BLOCK = 100;
const SNAP        = 106;     // STAKE_BLOCK + BTC activation delay (6) — the bond is active here
const SLASH_BLOCK = 110;
const STAKE_AMT   = '6000';  // > cross_chain MIN_STAKE (5000)

function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubHex: Buffer.from(der.slice(-32)).toString('hex') };
}
const sign = (priv, msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), priv).toString('hex');
const b64  = (s) => Buffer.from(s, 'utf8').toString('base64url');

// Gas bootstrap with a high MAX_MINT so A1 can hold a > MIN_STAKE bond — the shared
// seedGas caps the per-address MINT at 1000, but cross_chain MIN_STAKE is 5000. Issuing
// + minting the gas tick is fee-exempt, so A1 can self-mint from a zero balance.
async function seedGasRich(seeder) {
    await seeder.seedBlock(99, T - 600, [
        { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap', txHash: 'b'.repeat(56) + '00000001' },
        { source: A1,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'b'.repeat(56) + '00000002' },
    ]);
}

// XMATCH (XDEX) raw canonical — snapshot_block is field index 2.
function dexContent(snap, aAmount) {
    return ['XMATCH', 'm_1', String(snap),
            'BTC', '1', 'TICKA', String(aAmount), '0', 'addrA',
            'LTC', '2', 'TICKB', '5', '0', 'addrB',
            String(T), 'regtest', 'swap', '0', 'swap', '0'].join('|');
}

describe('Integration: live SLASH equivocation drill + determinism @regression @tier1', function () {
    this.timeout(120000);

    let offender, firstRun;

    // Deterministic corpus: the SAME offender key + Ed25519 sigs both runs.
    function buildCorpus() {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '10'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '20'));
        // SLASH|0|CAPABILITY|OFFENDER_PUBKEY|MSG_A|SIG_A|MSG_B|SIG_B (no EQUIV_KEY wire field)
        const slash = ['SLASH', '0', 'cross_chain', offender.pubHex,
                       b64(msgA), sign(offender.privateKey, msgA),
                       b64(msgB), sign(offender.privateKey, msgB)].join('|');
        return [
            { block: STAKE_BLOCK, time: T,       txs: [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }] },
            { block: SLASH_BLOCK, time: T + 600, txs: [{ source: A1, data: slash }] },
        ];
    }

    async function runCorpus() {
        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasRich(seeder);   // A1 holds enough XCHAIN to fund a > MIN_STAKE bond
        for (const b of buildCorpus()) await seeder.seedBlock(b.block, b.time, b.txs);

        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const chain = await indexerQuery(
                `SELECT b.block_index, t1.hash AS ledger, t2.hash AS actions
                 FROM blocks b
                 LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
                 LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
                 ORDER BY b.block_index ASC`);
            const stakeRows = await indexerQuery(
                `SELECT s.amount FROM stakes s JOIN index_pubkeys p ON p.id = s.signing_pubkey_id WHERE p.pubkey = ?`,
                [offender.pubHex]);
            const events = await indexerQuery(`SELECT capability, amount FROM capability_slash_events`);
            const debits = await indexerQuery(`SELECT target_table, prev_amount FROM capability_slash_debits ORDER BY id`);
            // Post-slash: the offender must no longer qualify for the capability (burned to 0).
            const stillValid = await indexer.indexerDb.getValidatorsByCapability('cross_chain', SLASH_BLOCK);
            return {
                chain: chain.map(r => ({ block_index: Number(r.block_index), ledger: r.ledger, actions: r.actions })),
                stakeAmounts: stakeRows.map(r => String(r.amount)),
                events, debits,
                offenderStillValid: stillValid.some(v => String(v.pubkey).toLowerCase() === offender.pubHex.toLowerCase()),
            };
        } finally {
            await destroyIndexer(indexer);
        }
    }

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        offender = genKey();   // one key, reused both runs
        await createDatabases();
        await createDecoderSchema();
        firstRun = await runCorpus();
    });

    after(async function () { await closeAll(); });

    it('the offender qualified for cross_chain before the slash (sanity)', async function () {
        // A fresh-DB pre-slash check: stake without the slash block, confirm membership.
        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasRich(seeder);
        await seeder.seedBlock(STAKE_BLOCK, T, [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);
        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const v = await indexer.indexerDb.getValidatorsByCapability('cross_chain', SNAP);
            assert.ok(v.some(x => String(x.pubkey).toLowerCase() === offender.pubHex.toLowerCase()),
                'offender must qualify for cross_chain at the snapshot block before being slashed');
        } finally {
            await destroyIndexer(indexer);
        }
    });

    it('the equivocation proof burns the offender\'s entire capability bond', function () {
        assert.ok(firstRun.stakeAmounts.length >= 1, 'offender must have a stake row');
        for (const a of firstRun.stakeAmounts)
            assert.strictEqual(Number(a), 0, 'offender stake must be burned to 0 (got ' + a + ')');
        assert.strictEqual(firstRun.offenderStillValid, false,
            'a slashed (zero-bond) validator must no longer qualify for the capability');
    });

    it('records exactly one capability_slash_event + a verbatim stakes debit', function () {
        assert.strictEqual(firstRun.events.length, 1, 'exactly one slash event');
        assert.strictEqual(firstRun.events[0].capability, 'cross_chain');
        assert.strictEqual(Number(firstRun.events[0].amount), Number(STAKE_AMT));
        const d = firstRun.debits.find(x => x.target_table === 'stakes');
        assert.ok(d, 'a stakes debit was logged for the reorg-restore path');
        assert.strictEqual(Number(d.prev_amount), Number(STAKE_AMT),
            'the debit records the verbatim pre-slash amount');
    });

    it('re-deriving from a clean DB yields the IDENTICAL hash chain (determinism = no fork)', async function () {
        const second = await runCorpus();
        assert.deepStrictEqual(second.chain, firstRun.chain,
            'SLASH processing produced different consensus hashes for the same input — fork risk');
        assert.deepStrictEqual(second.stakeAmounts, firstRun.stakeAmounts);
        assert.deepStrictEqual(second.events, firstRun.events);
    });
});
