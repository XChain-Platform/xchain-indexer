/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
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
 * Integration: CONTRACT_META_REQUIRED flag day, the REPLAY half of AT2.
 *
 * The consensus risk a new deploy verdict carries is not that it rejects the
 * contracts it is meant to reject: it is that it silently moves a verdict the
 * chain already recorded. A node that replays from genesis under the new code
 * must reproduce every PRE-ACTIVATION status and every pre-activation block hash
 * byte for byte, or it forks off its own history.
 *
 * This scenario drives both sides of that boundary on ONE chain:
 *
 *   1. Below the flag day a NAMELESS contract still deploys `valid` and stores
 *      four NULL meta columns, and a contract that happens to carry a conforming
 *      `meta` gets its columns for free (the verdict is gated, the extraction is
 *      not: see actions/deploy.js and spec 2.3 "below the flag day").
 *   2. Two INDEPENDENT indexer nodes replaying that pre-activation corpus from
 *      genesis produce byte-identical databases and an identical resolved hash
 *      chain (setup/equivalence.js).
 *   3. Extending the SAME chain past the flag day leaves every pre-activation
 *      block hash and every pre-activation status untouched, while the identical
 *      nameless shape now reads `invalid: CONTRACT_MANIFEST (meta required)`.
 *
 * HOW THE BOUNDARY IS CROSSED, and why this file runs on `testnet`. The rule is
 * block-TIME keyed (protocol_changes.js addChange, resolved through the decoder's
 * block_time). regtest arms it at 0, so on regtest there is no below-flag block to
 * replay at all: the regtest-active half is 16-controller-permissions. testnet
 * carries the UNARMED sentinel (9999999999, spec 2.4), which is a real block time
 * a decoder row can hold (block_time is BIGINT UNSIGNED on both schemas), so a
 * seeded block above it activates the rule on the same chain that carries the
 * blocks below it. That is strictly stronger than comparing two networks: the
 * pre-activation hashes compared before and after are the SAME rows of the SAME
 * ledger, so "the historic verdict did not move" is asserted directly rather than
 * inferred from a second run. Every other testnet gate is genesis-active (time 0)
 * except ISSUE_INHERITED_MINT_WINDOW and DEPLOY_DEFERRED_ASSEMBLY, which the
 * pre-activation block time is deliberately above, so the two halves differ in
 * exactly one activation: this one.
 *
 * AND THE CLOCK IS MEDIAN TIME PAST. testnet resolves protocol time from MTP over
 * the previous 11 blocks (src/protocol_time.js; regtest and mainnet read the raw
 * stamp), so ONE future-stamped block arms nothing: the corpus drags the median
 * across the sentinel with a short run of blocks, and the first of them carries a
 * nameless deploy that must still read `valid` precisely because its own stamp is
 * above the sentinel while the median below it is not. That is the same arithmetic
 * spec 2.4 puts on the release re-pin ("strictly above the tip and the tip's
 * median-time-past at re-pin").
 *
 * Run (disposable MariaDB; bin/run-db-tiers.sh provisions one):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=<db> TEST_INDEXER_DB=<db> TEST_INDEXER_DB_B=<db> \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> \
 *   npx mocha --no-config --no-package --exit \
 *       test/integration/scenarios/29-contract-meta-flag-day-replay.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, resetIndexerDbB,
        decoderQuery, indexerQuery, indexerBQuery, indexerDbNameB,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const { readHashChain, assertHashChainsEqual, assertIndexerDbsEquivalent }
    = require('../setup/equivalence');

// Valid P2PKH under the BTC testnet params (pubKeyHash 0x6f, shared with regtest).
const DEPLOYER = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
// Off regtest only the configured ADDRESS.GAS may issue the gas tick
// (actions/issue.js), so the preamble is funded by BTC testnet's own GAS address.
const GAS_TESTNET = 'mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D';

// Blocks sit above BTC testnet's firstBlock (149700, coins/BTC.js) so the corpus
// occupies heights this network really would carry.
const B_GAS   = 149700;
const B_PRE   = 149701;
// Empty blocks whose only job is to drag MEDIAN TIME PAST across the flag day; see
// B_POST. Three of them, so the median has a margin rather than sitting on the
// boundary element.
const B_FILL  = [149702, 149703, 149704];
const B_POST  = 149705;

// Below CONTRACT_META_REQUIRED_TESTNET_TIME (9999999999) and above every ARMED
// testnet gate (ISSUE_INHERITED_MINT_WINDOW 1787961600, DEPLOY_DEFERRED_ASSEMBLY
// 1788868800), so the pre-activation block runs the same rule set as the post one
// minus the meta verdict.
const T_GAS = 1788999400;
const T_PRE = 1789000000;
// Above the UNARMED sentinel: this is what "the flag day arrives" looks like to
// isEnabled, which compares the change's testnet_time against getBlockTime().
//
// AND THAT IS MEDIAN TIME PAST ON TESTNET, not the block's own stamp
// (src/protocol_time.js: MTP is on for testnet, off for mainnet and regtest). A
// single future-stamped block therefore activates NOTHING: db.getBlockTime medians
// the timestamps of the blocks BELOW it. With the two pre-activation blocks plus
// the three fillers below B_POST the window is [T_GAS, T_PRE, T_FILL x3], whose
// median is a T_FILL value, so B_POST is the first block whose PROTOCOL time is
// above the sentinel. This is the same arithmetic the release re-pin obeys (spec
// 2.4: strictly above the tip AND the tip's median-time-past).
const T_FILL = [10000000001, 10000000002, 10000000003];
const T_POST = 10000000004;

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// One number over a resolved hash chain, so the before/after comparison is readable
// in the run output. The ASSERTION is assertHashChainsEqual, which names the first
// divergent block; this only makes the same fact visible.
const chainDigest = chain => sha(JSON.stringify(chain));

// The frozen consensus token, written literally rather than imported from
// src/contract_meta.js: a test that reads the string out of the code under test
// proves only that the code agrees with itself.
const META_REQUIRED = 'invalid: CONTRACT_MANIFEST (meta required)';

const META = "meta:{ name:'Escrow', description:'Two-party escrow with an arbiter.', version:'1.0.0' }";

// Four sources, two shapes on each side of the boundary. The `era` key keeps the
// four code hashes distinct so each row is addressable by hash; it is the ONLY
// difference between a pre and post source of the same shape.
const NAMELESS_PRE  = "module.exports={ guard:function(){ return {}; }, era:'pre'  };";
// Deployed in a block whose RAW stamp is already above the sentinel while its MTP is
// not: the vector that proves the gate reads protocol time, not the block's own stamp.
const NAMELESS_MTP  = "module.exports={ guard:function(){ return {}; }, era:'mtp'  };";
const NAMELESS_POST = "module.exports={ guard:function(){ return {}; }, era:'post' };";
const NAMED_PRE     = `module.exports={ ${META}, guard:function(){ return {}; }, era:'pre'  };`;
const NAMED_POST    = `module.exports={ ${META}, guard:function(){ return {}; }, era:'post' };`;

describe('29 - CONTRACT_META_REQUIRED flag day: pre-activation replay + activation @regression @tier1', function () {
    this.timeout(600000);

    let seeder, nodeA;
    let prevCoin, prevNetwork;
    let preChainA = null;   // resolved hash chain after the pre-activation corpus only

    /** One contract row, addressed by the sha256 of its source. */
    async function rowFor(queryFn, code) {
        const h = sha(code);
        const rows = await queryFn(
            `SELECT c.action_index, c.code_hash, c.block_index,
                    s.status AS status,
                    c.meta_name, c.meta_description, c.meta_version, c.meta_json
             FROM contracts c
             LEFT JOIN index_statuses s ON s.id = c.status_id`, []);
        return rows.find(r => r.code_hash === h);
    }

    function assertNoMetaColumns(row, label) {
        assert.strictEqual(row.meta_name,        null, label + ': meta_name is NULL');
        assert.strictEqual(row.meta_description, null, label + ': meta_description is NULL');
        assert.strictEqual(row.meta_version,     null, label + ': meta_version is NULL');
        assert.strictEqual(row.meta_json,        null, label + ': meta_json is NULL');
    }

    before(async function () {
        // Real DEPLOY needs the isolated-vm-backed xchain-vm; skip rather than
        // report a venue gap as a product failure (same guard as scenario 16).
        try { require('xchain-vm'); } catch (e) { return this.skip(); }

        // testnet is the network that carries the UNARMED sentinel. Mocha runs
        // every file in one process and the other scenarios read
        // `process.env.INDEXER_NETWORK || 'regtest'`, so leaking testnet out of
        // this file would silently re-network whichever suite runs next; the env
        // is restored in after().
        prevCoin    = process.env.INDEXER_COIN;
        prevNetwork = process.env.INDEXER_NETWORK;
        process.env.INDEXER_COIN    = 'BTC';
        process.env.INDEXER_NETWORK = 'testnet';

        await createDatabases(__filename);
        await createDecoderSchema();
        await resetIndexerDbB();

        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { blockIndex: B_GAS, blockTime: T_GAS,
                                funder: GAS_TESTNET, addresses: [DEPLOYER], amount: '100' });
        await seeder.seedBlock(B_PRE, T_PRE, [
            { source: DEPLOYER, data: `DEPLOY|0|${b64(NAMELESS_PRE)}|300000|` },
            { source: DEPLOYER, data: `DEPLOY|0|${b64(NAMED_PRE)}|300000|` },
        ]);

        nodeA = await initIndexer();
        await processBlocks(nodeA);
        preChainA = await readHashChain(indexerQuery);
    });

    after(async function () {
        if (nodeA) await destroyIndexer(nodeA);
        await destroyFileIndexers(__filename);
        await closeAll();
        restoreEnv('INDEXER_COIN', prevCoin);
        restoreEnv('INDEXER_NETWORK', prevNetwork);
    });

    function restoreEnv(name, value) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    // ------------------------------------------------------------------
    // Below the flag day: historic verdicts, and free storage
    // ------------------------------------------------------------------

    it('below the flag day a NAMELESS deploy is still valid, with four NULL meta columns', async function () {
        const row = await rowFor(indexerQuery, NAMELESS_PRE);
        assert.ok(row, 'the nameless pre-activation contract was deployed');
        assert.strictEqual(row.status, 'valid',
            'a nameless deploy below the flag day keeps its historic verdict, got: ' + row.status);
        assertNoMetaColumns(row, 'pre-activation nameless');
    });

    it('below the flag day a CONFORMING meta is extracted and stored anyway (verdict gated, extraction not)', async function () {
        const row = await rowFor(indexerQuery, NAMED_PRE);
        assert.ok(row, 'the named pre-activation contract was deployed');
        assert.strictEqual(row.status, 'valid', 'a named deploy is valid below the flag day too');
        assert.strictEqual(row.meta_name,        'Escrow');
        assert.strictEqual(row.meta_description, 'Two-party escrow with an arbiter.');
        assert.strictEqual(row.meta_version,     '1.0.0');
        assert.deepStrictEqual(JSON.parse(row.meta_json),
            { name: 'Escrow', description: 'Two-party escrow with an arbiter.', version: '1.0.0' },
            'meta_json holds the isolate bytes verbatim');
    });

    it('a second node replaying the pre-activation corpus from genesis is byte-identical (DB + hash chain)', async function () {
        const nodeB = await initIndexer({ indexerName: indexerDbNameB() });
        try {
            await processBlocks(nodeB);
            const chainB = await readHashChain(indexerBQuery);
            assertHashChainsEqual(preChainA, chainB, 'node A', 'node B (fresh replay)');
            await assertIndexerDbsEquivalent(indexerQuery, indexerBQuery,
                { mode: 'strict', labelA: 'node A', labelB: 'node B (fresh replay)' });
            // The replayed verdict, read off the independent node rather than
            // inferred from hash equality alone.
            const rowB = await rowFor(indexerBQuery, NAMELESS_PRE);
            assert.strictEqual(rowB.status, 'valid',
                'the fresh replay reproduced the historic nameless verdict');
            assertNoMetaColumns(rowB, 'node B nameless');
        } finally {
            await destroyIndexer(nodeB);
        }
    });

    // ------------------------------------------------------------------
    // Crossing the flag day on the SAME chain
    // ------------------------------------------------------------------

    describe('after the flag-day block time arrives', function () {
        let postChainA = null;

        before(async function () {
            if (!nodeA) return this.skip();
            // The filler blocks exist so MTP (the value isEnabled actually compares)
            // crosses the sentinel at B_POST. The FIRST one carries a nameless deploy
            // on purpose: its raw stamp is already above the sentinel while its MTP is
            // not, so its verdict says which clock the gate reads.
            for (let i = 0; i < B_FILL.length; i++)
                await seeder.seedBlock(B_FILL[i], T_FILL[i], i === 0
                    ? [{ source: DEPLOYER, data: `DEPLOY|0|${b64(NAMELESS_MTP)}|300000|` }]
                    : []);
            await seeder.seedBlock(B_POST, T_POST, [
                { source: DEPLOYER, data: `DEPLOY|0|${b64(NAMELESS_POST)}|300000|` },
                { source: DEPLOYER, data: `DEPLOY|0|${b64(NAMED_POST)}|300000|` },
            ]);
            await processBlocks(nodeA);
            postChainA = await readHashChain(indexerQuery);
        });

        it('every PRE-activation block hash is byte-identical to the pre-activation replay', function () {
            assert.ok(postChainA.length > preChainA.length,
                'the post-activation block was processed (chain grew)');
            const prefix = postChainA.slice(0, preChainA.length);
            // Printed so a reviewer can read the comparison off the run rather than
            // taking the assertion's word for it.
            console.log('[29] pre-activation chain digest: before=' + chainDigest(preChainA) +
                        ' after=' + chainDigest(prefix) +
                        ' (blocks ' + preChainA.map(b => b.block_index).join(',') + ')');
            assertHashChainsEqual(preChainA, prefix,
                'pre-activation replay', 'the same blocks after the flag day arrived');
        });

        it('the pre-activation rows keep their historic statuses and columns', async function () {
            const nameless = await rowFor(indexerQuery, NAMELESS_PRE);
            assert.strictEqual(nameless.status, 'valid',
                'the pre-activation nameless verdict did not move when the rule armed');
            assertNoMetaColumns(nameless, 'pre-activation nameless (after arming)');
            const named = await rowFor(indexerQuery, NAMED_PRE);
            assert.strictEqual(named.status, 'valid');
            assert.strictEqual(named.meta_name, 'Escrow');
        });

        it('the gate reads PROTOCOL time: a block stamped past the sentinel is still below it while its MTP is', async function () {
            // B_FILL[0]'s own timestamp is above CONTRACT_META_REQUIRED_TESTNET_TIME,
            // but db.getBlockTime medians the blocks below it, and that median is still
            // a pre-activation stamp. A gate wired to the raw stamp would reject here;
            // the rule is not armed until MTP crosses, which is what the release re-pin
            // is written against.
            const row = await rowFor(indexerQuery, NAMELESS_MTP);
            assert.ok(row, 'the future-stamped nameless contract was deployed');
            assert.strictEqual(Number(row.block_index), B_FILL[0]);
            assert.strictEqual(row.status, 'valid',
                'MTP, not the raw stamp, decides activation; got: ' + row.status);
            assertNoMetaColumns(row, 'future-stamped nameless');
        });

        it('at/after the flag day the same nameless shape is REJECTED with the meta-required string', async function () {
            const row = await rowFor(indexerQuery, NAMELESS_POST);
            assert.ok(row, 'the nameless post-activation contract row exists with its verdict');
            assert.strictEqual(row.status, META_REQUIRED,
                'a nameless deploy at/after the flag day is rejected, got: ' + row.status);
            assertNoMetaColumns(row, 'post-activation nameless');
        });

        it('at/after the flag day a named deploy is valid and carries its meta columns', async function () {
            const row = await rowFor(indexerQuery, NAMED_POST);
            assert.ok(row, 'the named post-activation contract was deployed');
            assert.strictEqual(row.status, 'valid',
                'a conforming meta deploys valid at/after the flag day, got: ' + row.status);
            assert.strictEqual(row.meta_name,        'Escrow');
            assert.strictEqual(row.meta_description, 'Two-party escrow with an arbiter.');
            assert.strictEqual(row.meta_version,     '1.0.0');
        });
    });
});
