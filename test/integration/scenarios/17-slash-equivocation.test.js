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
 * Integration: LIVE SLASH equivocation drill + cross-node determinism (WI-2 bump 2).
 *
 * Drives a real equivocation end-to-end through the REAL indexer against a real DB:
 *   1. STAKE a validator's capability bond (6000 XCHAIN → qualifies for cross_chain,
 *      MIN_STAKE 5000) from the gas funder (the bootstrap MINT caps at 1000/addr).
 *   2. The validator EQUIVOCATES (signs two conflicting XMATCH (XDEX) canonicals) for
 *      the same (engine, round, view), EQUIV-headered (regtest activates the header at
 *      genesis). Real Ed25519, deterministic so both determinism runs are byte-equal.
 *   3. A permissionless SLASH|0 wire action carries the two messages + sigs.
 *   4. Assert the indexer BURNS the whole bond, writes the capability_slash_event +
 *      verbatim debit, and (the consensus property) re-deriving from a clean DB yields
 *      the IDENTICAL chained block hashes; non-determinism here = a fork.
 *
 * Mirrors the harness of 10-determinism-baseline. Needs a disposable MariaDB (TEST_DB_*).
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

// The regtest gas funder (configs/BTC.js ADDRESS.GAS) holds the full bootstrap supply,
// so it can fund a >MIN_STAKE bond (the per-address seedGas MINT caps at 1000).
const FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';
const A1     = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const T = 1700000000;

const STAKE_BLOCK  = 100;
const ACTIVE_BLOCK = 106;    // STAKE_BLOCK + BTC activation delay (6); the bond is active here
// The RAW snapshot_block the proof declares. A verifier resolves the set at
// buriedSnapshotBlock(SNAP) = SNAP - CANONICAL_REORG_BUFFER, which is where the hub that
// locked the slot resolved its own signer set, so the declared height a real proof carries
// sits a buffer ABOVE the height the bond has to be active at. Pinning SNAP to
// ACTIVE_BLOCK describes a slot no hub could have locked this staker into: buried, it
// lands on block 100, where the stake is still pending.
const SNAP        = ACTIVE_BLOCK + srb.CANONICAL_REORG_BUFFER;   // 112
const SLASH_BLOCK = 115;
const STAKE_AMT   = '6000';  // > cross_chain MIN_STAKE (5000)

function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubHex: Buffer.from(der.slice(-32)).toString('hex') };
}
const sign = (priv, msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), priv).toString('hex');
const b64  = (s) => Buffer.from(s, 'utf8').toString('base64url');

// Gas bootstrap with a high MAX_MINT so A1 can hold a > MIN_STAKE bond; the shared
// seedGas caps the per-address MINT at 1000, but cross_chain MIN_STAKE is 5000. Issuing
// + minting the gas tick is fee-exempt, so A1 can self-mint from a zero balance.
async function seedGasRich(seeder) {
    await seeder.seedBlock(99, T - 600, [
        { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap', txHash: 'b'.repeat(56) + '00000001' },
        { source: A1,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'b'.repeat(56) + '00000002' },
    ]);
}

// XMATCH (XDEX) raw canonical: snapshot_block is field index 2.
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
        await createDatabases(__filename);
        await createDecoderSchema();
        firstRun = await runCorpus();
    });

    after(async function () { await destroyFileIndexers(__filename); await closeAll(); });

    it('the offender qualified for cross_chain at the RESOLVED snapshot height before the slash (sanity)', async function () {
        // A fresh-DB pre-slash check: stake without the slash block, confirm membership.
        // Queried at buriedSnapshotBlock(SNAP), the height the verifier actually resolves
        // the proof's set at, so this sanity check and the SLASH path read one set. Asserting
        // membership at the RAW declared height would pass while the SLASH path rejects.
        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasRich(seeder);
        await seeder.seedBlock(STAKE_BLOCK, T, [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);
        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const resolved = srb.buriedSnapshotBlock(SNAP, 'regtest');
            assert.strictEqual(resolved, ACTIVE_BLOCK,
                'the fixture must bury onto the activation block, or it is not testing the slot a hub could lock');
            const v = await indexer.indexerDb.getValidatorsByCapability('cross_chain', resolved);
            assert.ok(v.some(x => String(x.pubkey).toLowerCase() === offender.pubHex.toLowerCase()),
                'offender must qualify for cross_chain at the resolved snapshot block before being slashed');
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
            'SLASH processing produced different consensus hashes for the same input (fork risk)');
        assert.deepStrictEqual(second.stakeAmounts, firstRun.stakeAmounts);
        assert.deepStrictEqual(second.events, firstRun.events);
    });

    // Permanent disqualification (WI-2 bump 2): a slashed key may never re-qualify, even on a
    // FRESH stake from a DIFFERENT source: the exclusion is keyed on the signing key, global,
    // and permanent. Drives STAKE → SLASH → re-STAKE(same key, new source) and asserts the key
    // stays out of EVERY effective-set read (capability set, whole-federation set, per-key test).
    it('a slashed key stays disqualified after a fresh re-stake from a new source (global + permanent)', async function () {
        const A2 = 'n2eA5RtRGr5gQ7BJzm5xnvf8oZ9z6bK1pe';   // a second, independent staking source
        const RESTAKE_BLOCK = 120, AFTER = 130;
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '10'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_1', 0, dexContent(SNAP, '20'));
        const slash = ['SLASH', '0', 'cross_chain', offender.pubHex,
                       b64(msgA), sign(offender.privateKey, msgA),
                       b64(msgB), sign(offender.privateKey, msgB)].join('|');

        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        // Fund BOTH sources so each can post a > MIN_STAKE bond for the SAME signing key.
        await seeder.seedBlock(99, T - 600, [
            { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap', txHash: 'c'.repeat(56) + '00000001' },
            { source: A1,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'c'.repeat(56) + '00000002' },
            { source: A2,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'c'.repeat(56) + '00000003' },
        ]);
        await seeder.seedBlock(STAKE_BLOCK,   T,        [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);
        await seeder.seedBlock(SLASH_BLOCK,   T + 600,  [{ source: A1, data: slash }]);
        await seeder.seedBlock(RESTAKE_BLOCK, T + 1200, [{ source: A2, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);

        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const isOffender = (v) => String(v.pubkey).toLowerCase() === offender.pubHex.toLowerCase();

            // The re-stake row exists and is active (activation delay 6 → active by AFTER)…
            const restake = await indexerQuery(
                `SELECT s.amount FROM stakes s JOIN index_pubkeys p ON p.id = s.signing_pubkey_id
                 WHERE p.pubkey = ? AND s.source_id = (SELECT id FROM index_addresses WHERE address = ?)`,
                [offender.pubHex, A2]);
            assert.ok(restake.length >= 1 && Number(restake[0].amount) === Number(STAKE_AMT),
                'the fresh re-stake row must exist at full amount (the slash does not touch a later stake)');

            // …yet the key qualifies NOWHERE: capability set, whole-federation set, per-key test.
            const capSet = await indexer.indexerDb.getValidatorsByCapability('cross_chain', AFTER);
            assert.ok(!capSet.some(isOffender), 'slashed key must NOT re-qualify for its capability after re-stake');

            const fedSet = await indexer.indexerDb.getActiveValidators(AFTER);
            assert.ok(!fedSet.some(isOffender), 'slashed key must NOT re-enter the whole-federation set (XCONFIG membership)');

            const weights = await indexer.indexerDb.getStakeWeightsByCapability('cross_chain', AFTER);
            assert.ok(!weights.some(isOffender), 'slashed key must NOT re-enter the stake-weighted set');

            assert.strictEqual(await indexer.indexerDb.hasCapability(offender.pubHex, 'cross_chain', AFTER), false,
                'per-key membership test must also report the slashed key as disqualified');
            // (The exclusion is block-gated in the SQL via `cse.block_index <= ?`, so a block-by-block
            //  re-derivation never disqualifies before the slash exists; the determinism test above
            //  exercises that path. It is not observable in a post-hoc snapshot query here because the
            //  burn also zeroes the historical stake amount in place.)
        } finally {
            await destroyIndexer(indexer);
        }
    });

    // XCONFIG (the 6th engine): config-change equivocation is slashable via the Phase-A
    // amendment: the signed content carries the round's locked snapshot_block as
    // `snapshot_block|digest`, and membership resolves against the WHOLE federation
    // (getActiveValidators), not a capability subset. The bond still burns whole.
    it('an XCONFIG equivocation burns the bond via whole-federation membership', async function () {
        const SEQ = '5', VIEW = 0;
        // content = `<snapshot_block>|<config_digest>`; same (seq, view) + same block, DIFFERENT digest.
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, SEQ, VIEW, SNAP + '|' + 'a'.repeat(64));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, SEQ, VIEW, SNAP + '|' + 'b'.repeat(64));
        const slash = ['SLASH', '0', 'config', offender.pubHex,
                       b64(msgA), sign(offender.privateKey, msgA),
                       b64(msgB), sign(offender.privateKey, msgB)].join('|');

        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);
        await seedGasRich(seeder);
        // A modest stake is enough; the federation set has NO MIN_STAKE floor, so any active
        // staker is a config signer. (6000 also keeps the offender a cross_chain member, fine.)
        await seeder.seedBlock(STAKE_BLOCK, T,       [{ source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + offender.pubHex }]);
        await seeder.seedBlock(SLASH_BLOCK, T + 600, [{ source: A1, data: slash }]);

        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const events = await indexerQuery(`SELECT capability, amount, bounty_amount, treasury_amount FROM capability_slash_events`);
            assert.strictEqual(events.length, 1, 'exactly one config slash event');
            assert.strictEqual(events[0].capability, 'config', 'event is labelled with the config sentinel');
            assert.strictEqual(Number(events[0].amount), Number(STAKE_AMT), 'the whole bond burned');
            // CONFIG_SLASH wired end-to-end: 5% of 6000 = 300 (above the 50 floor, below the 1000 cap),
            // remainder to treasury (burned; no TREASURY_ADDRESS). Conservation: bounty+treasury==burned.
            assert.strictEqual(Number(events[0].bounty_amount), 300, 'config equivocation pays the configured bounty');
            assert.strictEqual(Number(events[0].treasury_amount), Number(STAKE_AMT) - 300, 'remainder routed to treasury (burned)');

            const stakeRows = await indexerQuery(
                `SELECT s.amount FROM stakes s JOIN index_pubkeys p ON p.id = s.signing_pubkey_id WHERE p.pubkey = ?`,
                [offender.pubHex]);
            for (const r of stakeRows)
                assert.strictEqual(Number(r.amount), 0, 'config equivocation burns the whole bond to 0');
        } finally {
            await destroyIndexer(indexer);
        }
    });
});
