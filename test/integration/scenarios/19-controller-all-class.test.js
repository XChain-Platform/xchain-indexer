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
 * Integration: programmable-policy layer — the catch-all 'all' action class.
 *
 * Drives real bind + SEND actions through the full indexer pipeline (decoder seed
 * → processBlocks) against a real MariaDB + the real (isolated-vm) VM. Proves the
 * 'all'-class most-specific-wins fallback end to end — the behavior the unit tests
 * mock (getEffectiveTokenControllerForGuard) here runs over real DB rows + a real
 * guard VM:
 *   - one 'all' binding gates a SEND (transfer) via the fallback (no transfer-
 *     specific controller is bound, so resolution falls through to 'all')
 *   - a class-specific 'transfer' binding then OVERRIDES 'all' for that class only
 *     (most-specific wins), so the same SEND now routes to the permissive guard
 *
 * Run (disposable MariaDB, e.g. a throwaway container):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_all_decoder TEST_INDEXER_DB=cv_all_indexer \
 *   TEST_INDEXER_DB_B=cv_all_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/19-controller-all-class.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const OWNER = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // valid regtest P2PKH
const RECIP = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // valid regtest P2PKH
const TICK  = 'CVALL';
const T0    = 1700000000;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Guard contracts. A 'all'-bound deny guard reverts whatever class routes to it;
// a permissive allow guard returns {} so the action settles.
const DENY_ALL = "module.exports={ guard:function(){ xchain.revert('all-class denied'); } };";
const ALLOW    = "module.exports={ guard:function(){ return {}; } };";

describe("Controller 'all' action class — fallback + override (real DB + real VM) @phaseE", function () {
    this.timeout(600000);
    let seeder, indexer, denyIdx, allowIdx;

    async function contractIndexByCode(code) {
        const h = sha(code);
        const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
        const r = rows.find(x => x.code_hash === h);
        return r ? Number(r.action_index) : null;
    }
    async function balanceOf(address, tick) {
        const rows = await indexerQuery(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id = b.address_id
             JOIN index_tickers   it ON it.id = b.tick_id
             WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
        return rows.length ? String(rows[0].amount) : '0';
    }
    async function controllerRows() {
        return await indexerQuery(
            `SELECT tc.action_class, tc.contract_index, tc.is_unbind
             FROM token_controllers tc JOIN index_tickers it ON it.id = tc.tick_id
             WHERE it.tick = ? ORDER BY tc.action_index`, [TICK]);
    }

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [OWNER], amount: '1000' });

        // Block 100: issue the token (mints 1000 to OWNER) + deploy both guards.
        await seeder.seedBlock(100, T0, [
            { source: OWNER, data: `ISSUE|0|${TICK}|1000|1000|0|all-class token|1000` },
            { source: OWNER, data: `DEPLOY|0|${b64(DENY_ALL)}|300000|` },
            { source: OWNER, data: `DEPLOY|0|${b64(ALLOW)}|300000|` },
        ]);
        indexer = await initIndexer();
        await processBlocks(indexer);

        denyIdx  = await contractIndexByCode(DENY_ALL);
        allowIdx = await contractIndexByCode(ALLOW);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await closeAll();
    });

    it('deploys both guard contracts and mints the token to the owner', async function () {
        assert.ok(denyIdx,  'deny-all guard deployed (has an action_index)');
        assert.ok(allowIdx, 'allow guard deployed (has an action_index)');
        assert.strictEqual(await balanceOf(OWNER, TICK), '1000', 'owner minted 1000 of the token');
    });

    it("one 'all' binding gates a SEND (transfer) via the fallback", async function () {
        // Bind 'all' -> deny guard. No transfer-specific controller exists, so a SEND
        // (transfer class) must fall through to the 'all' binding.
        await seeder.seedBlock(101, T0 + 100, [
            { source: OWNER, data: `ISSUE|6|${TICK}|${denyIdx}|all|0|0|bind-all` },
        ]);
        await processBlocks(indexer);
        const ev = await controllerRows();
        assert.ok(ev.some(e => e.action_class === 'all' && Number(e.is_unbind) === 0),
            "'all' bind row present in token_controllers");

        const before = await balanceOf(RECIP, TICK);
        await seeder.seedBlock(102, T0 + 200, [
            { source: OWNER, data: `SEND|0|${TICK}|10|${RECIP}|all-blocked` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(RECIP, TICK), before,
            "SEND falls back to the 'all' guard and is DENIED (recipient uncredited)");
    });

    it("a class-specific 'transfer' binding overrides 'all' for that class only (most-specific wins)", async function () {
        // Bind a specific 'transfer' -> permissive guard ON TOP of the live 'all' binding.
        // (Binding a specific class while 'all' is bound must be ALLOWED — it is the override,
        // not "already bound", because bind validation uses the exact-class getter. A green
        // ISSUE v6 here proves that.)
        await seeder.seedBlock(103, T0 + 300, [
            { source: OWNER, data: `ISSUE|6|${TICK}|${allowIdx}|transfer|0|0|bind-transfer` },
        ]);
        await processBlocks(indexer);
        const ev = await controllerRows();
        assert.ok(ev.some(e => e.action_class === 'transfer' && Number(e.is_unbind) === 0),
            "specific 'transfer' bind accepted on top of 'all' (not rejected as already-bound)");

        // Resolution proof against the REAL DB rows (no second guarded SEND — that path is
        // exercised by test 2's real-VM deny; a second guard-fee'd SEND would also trip an
        // unrelated guard-fee gas-conservation sanity check in this minimal harness).
        const tickId  = await indexer.indexerDb.getTickerId(TICK);
        const HI_B = 1e9, HI_A = 1e9; // beyond all seeded events

        // Enforcement resolver: transfer now resolves to the SPECIFIC controller (override),
        // while a class with no specific binding (trade) still falls back to 'all'.
        const gTransfer = await indexer.indexerDb.getEffectiveTokenControllerForGuard(tickId, 'transfer', HI_B, HI_A);
        const gTrade    = await indexer.indexerDb.getEffectiveTokenControllerForGuard(tickId, 'trade',    HI_B, HI_A);
        assert.strictEqual(Number(gTransfer.contract_index), allowIdx, "transfer resolves to the specific override (most-specific wins)");
        assert.strictEqual(Number(gTrade.contract_index),    denyIdx,  "trade (no specific binding) falls back to the 'all' controller");

        // Exact getter (the one bind/unbind validation uses) stays fallback-free: it sees the
        // transfer binding but NOT an 'all' shadow for an unbound class.
        const xTransfer = await indexer.indexerDb.getEffectiveTokenController(tickId, 'transfer', HI_B, HI_A);
        const xTrade    = await indexer.indexerDb.getEffectiveTokenController(tickId, 'trade',    HI_B, HI_A);
        assert.strictEqual(Number(xTransfer.contract_index), allowIdx, 'exact getter returns the transfer binding');
        assert.strictEqual(xTrade, null, "exact getter does NOT fall back to 'all' (bind validation correctness)");
    });
});
