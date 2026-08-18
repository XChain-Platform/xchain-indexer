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
 * Integration: bulk transfers (AIRDROP / DIVIDEND / SWEEP) are gated by the transfer-class
 * token controller (real MariaDB + real isolated-vm guard).
 *
 * Closes the finding that a transfer-class controller (allowlist/freeze/compliance) was
 * bypassable via SWEEP/AIRDROP/DIVIDEND: only SEND routed through the guard. These three
 * now map to the `transfer` class and gate the AGGREGATE outbound move once per controlled
 * tick (bounded, fail-closed). Proves, over real DB rows + a real guard VM:
 *   1. AIRDROP: a transfer-class DENY reverts the airdrop (no recipient credited); an ALLOW
 *      commits it and the block passes the supply sanity check (guard-fee GAS burn conserved).
 *   2. DIVIDEND: same, on the DIVIDEND_TICK.
 *   3. SWEEP: a DENY on any swept tick fails the WHOLE sweep (fail-closed); an ALLOW commits
 *      and the block passes sanity.
 *
 * Run (disposable MariaDB, e.g. the integration venue):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=<u> TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_bt_decoder TEST_INDEXER_DB=cv_bt_indexer TEST_INDEXER_DB_B=cv_bt_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/25-controller-bulk-transfer-gating.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const OWNER  = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues tokens, binds, airdrops/dividends
const HOLDER = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // holds PLAIN (dividend recipient)
const RECIP  = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // airdrop list recipient
const SW1    = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // sweep-DENY source (holds GATED1)
const SW2    = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86'; // sweep-ALLOW source (holds GATED2 + PLAIN)
const DEST   = 'mnNFBtAigY3EHSCJUZwpyugkphfruNiPHj'; // sweep destination

const GATED1 = 'CBT1'; // transfer -> DENY
const GATED2 = 'CBT2'; // transfer -> ALLOW
const PLAIN  = 'CBTP'; // no controller
const T0     = 1700000000;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const DENY  = "module.exports={ guard:function(){ xchain.revert('policy denied'); } };";
const ALLOW = "module.exports={ guard:function(){ return {}; } };";

describe('Controller: AIRDROP/DIVIDEND/SWEEP gated by the transfer controller (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer, denyIdx, allowIdx, listIdx;

    async function contractIndexByCode(code) {
        const h = sha(code);
        const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
        const r = rows.find(x => x.code_hash === h);
        return r ? Number(r.action_index) : null;
    }
    async function firstListActionIndex() {
        const rows = await indexerQuery(
            `SELECT a.action_index AS ai FROM actions a
             JOIN index_actions ia ON ia.id = a.action_id
             WHERE ia.action = 'LIST' ORDER BY a.action_index ASC LIMIT 1`, []);
        return rows.length ? Number(rows[0].ai) : null;
    }
    async function balanceOf(address, tick) {
        const rows = await indexerQuery(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id = b.address_id
             JOIN index_tickers   it ON it.id = b.tick_id
             WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
        return rows.length ? String(rows[0].amount) : '0';
    }

    before(async function () {
        try { require('xchain-vm'); } catch (e) { return this.skip(); }
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [OWNER, SW1, SW2], amount: '1000' });

        // Block 100: issue tokens (to OWNER), deploy the deny/allow guards, and create an
        // address LIST holding RECIP for the airdrop.
        await seeder.seedBlock(100, T0, [
            { source: OWNER, data: `ISSUE|0|${GATED1}|100000|10000|0|gated one|1000` },
            { source: OWNER, data: `ISSUE|0|${GATED2}|100000|10000|0|gated two|1000` },
            { source: OWNER, data: `ISSUE|0|${PLAIN}|1000|1000|0|plain token|1000` },
            { source: OWNER, data: `DEPLOY|0|${b64(DENY)}|300000|` },
            { source: OWNER, data: `DEPLOY|0|${b64(ALLOW)}|300000|` },
            { source: OWNER, data: `LIST|0|2||${RECIP}` },
        ]);
        indexer = await initIndexer();
        await processBlocks(indexer);
        denyIdx  = await contractIndexByCode(DENY);
        allowIdx = await contractIndexByCode(ALLOW);
        listIdx  = await firstListActionIndex();

        // Block 101: distribute tokens BEFORE binding (ungated sends): GATED1 -> SW1;
        // GATED2 + PLAIN -> SW2; PLAIN -> HOLDER.
        await seeder.seedBlock(101, T0 + 100, [
            { source: OWNER, data: `SEND|0|${GATED1}|500|${SW1}|seed-sw1` },
            { source: OWNER, data: `SEND|0|${GATED2}|500|${SW2}|seed-sw2` },
            { source: OWNER, data: `SEND|0|${PLAIN}|100|${SW2}|seed-sw2p` },
            { source: OWNER, data: `SEND|0|${PLAIN}|50|${HOLDER}|seed-holder` },
        ]);
        await processBlocks(indexer);

        // Block 102: bind the transfer controllers (GATED1 -> deny, GATED2 -> allow).
        await seeder.seedBlock(102, T0 + 200, [
            { source: OWNER, data: `ISSUE|6|${GATED1}|${denyIdx}|transfer|0|0|bind-t-deny` },
            { source: OWNER, data: `ISSUE|6|${GATED2}|${allowIdx}|transfer|0|0|bind-t-allow` },
        ]);
        await processBlocks(indexer);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await closeAll();
    });

    it('set up tokens, guards, address list, and distributions', async function () {
        assert.ok(denyIdx,  'deny guard deployed');
        assert.ok(allowIdx, 'allow guard deployed');
        assert.ok(listIdx,  'airdrop address list created');
        assert.strictEqual(await balanceOf(SW1, GATED1), '500', 'SW1 seeded with the deny-controlled tick');
        assert.strictEqual(await balanceOf(SW2, GATED2), '500', 'SW2 seeded with the allow-controlled tick');
        assert.strictEqual(await balanceOf(HOLDER, PLAIN), '50', 'HOLDER seeded with PLAIN (dividend recipient)');
    });

    // --- AIRDROP ---
    it('a transfer-class DENY reverts an AIRDROP (no recipient credited)', async function () {
        const before = await balanceOf(RECIP, GATED1);
        await seeder.seedBlock(110, T0 + 1000, [
            { source: OWNER, data: `AIRDROP|0|${GATED1}|10|${listIdx}|drop-deny` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(RECIP, GATED1), before,
            'AIRDROP denied by the transfer controller: recipient uncredited');
    });

    it('a transfer-class ALLOW commits an AIRDROP and the block passes the supply sanity check', async function () {
        const before = Number(await balanceOf(RECIP, GATED2));
        await seeder.seedBlock(111, T0 + 1100, [
            { source: OWNER, data: `AIRDROP|0|${GATED2}|10|${listIdx}|drop-allow` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(Number(await balanceOf(RECIP, GATED2)) - before, 10,
            'allowed AIRDROP credited the recipient and the block committed (sanity passed)');
    });

    // --- DIVIDEND ---
    it('a transfer-class DENY reverts a DIVIDEND (no holder credited)', async function () {
        const before = await balanceOf(HOLDER, GATED1);
        await seeder.seedBlock(112, T0 + 1200, [
            { source: OWNER, data: `DIVIDEND|0|${PLAIN}|${GATED1}|1|div-deny` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(HOLDER, GATED1), before,
            'DIVIDEND denied by the transfer controller on DIVIDEND_TICK: holder uncredited');
    });

    it('a transfer-class ALLOW commits a DIVIDEND and the block passes the supply sanity check', async function () {
        const before = Number(await balanceOf(HOLDER, GATED2));
        await seeder.seedBlock(113, T0 + 1300, [
            { source: OWNER, data: `DIVIDEND|0|${PLAIN}|${GATED2}|1|div-allow` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(Number(await balanceOf(HOLDER, GATED2)) - before, 50,
            'allowed DIVIDEND credited the holder its PLAIN-weighted share and committed (sanity passed)');
    });

    // --- SWEEP ---
    it('a transfer-class DENY on any swept tick fails the WHOLE sweep (fail-closed)', async function () {
        const beforeSrc  = await balanceOf(SW1, GATED1);
        const beforeDest = await balanceOf(DEST, GATED1);
        await seeder.seedBlock(114, T0 + 1400, [
            { source: SW1, data: `SWEEP|0|${DEST}|1|0|0|0|0|sweep-deny` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(SW1, GATED1), beforeSrc,
            'the controlled tick was NOT swept (whole sweep denied)');
        assert.strictEqual(await balanceOf(DEST, GATED1), beforeDest,
            'the sweep destination received nothing (fail-closed on the denied tick)');
    });

    it('a transfer-class ALLOW commits a SWEEP of the controlled tick and the block passes sanity', async function () {
        const beforeDestG2 = Number(await balanceOf(DEST, GATED2));
        const beforeDestP  = Number(await balanceOf(DEST, PLAIN));
        const sw2g2 = Number(await balanceOf(SW2, GATED2));
        const sw2p  = Number(await balanceOf(SW2, PLAIN));
        await seeder.seedBlock(115, T0 + 1500, [
            { source: SW2, data: `SWEEP|0|${DEST}|1|0|0|0|0|sweep-allow` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(Number(await balanceOf(DEST, GATED2)) - beforeDestG2, sw2g2,
            'allowed SWEEP moved the controlled GATED2 balance to the destination');
        assert.strictEqual(Number(await balanceOf(DEST, PLAIN)) - beforeDestP, sw2p,
            'the uncontrolled PLAIN balance swept alongside it');
        assert.strictEqual(await balanceOf(SW2, GATED2), '0', 'source emptied of the controlled tick');
    });
});
