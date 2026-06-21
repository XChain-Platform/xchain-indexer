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
 * Integration: programmable-policy layer, Phase C enforcement surfaces.
 *
 * Drives real bind + action flows through the full indexer pipeline (decoder seed ->
 * processBlocks) against a real MariaDB + the real (isolated-vm) VM. Proves the three
 * Phase C enforcement points the unit tests mock, here over real DB rows + a real
 * guard VM:
 *   1. MINT: a `mint`-class token controller gates supply creation (deny reverts the
 *      mint; allow commits and the block passes the supply sanity check).
 *   2. STAKE: a `stake`-class token controller gates v3 contract-targeted staking
 *      (deny reverts; allow commits and debits the bond).
 *   3. SOURCE-outbound self-gate: a `transfer` ADDRESS controller on the SENDER gates
 *      its OWN outbound SEND (symmetric binding; deny reverts the outbound move; allow
 *      commits and the block passes sanity, the guard-fee GAS burn is conserved).
 *
 * Run (disposable MariaDB, e.g. a throwaway container):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_pc_decoder TEST_INDEXER_DB=cv_pc_indexer \
 *   TEST_INDEXER_DB_B=cv_pc_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/21-controller-mint-stake-outbound.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const OWNER  = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues tokens, binds, mints/stakes
const OWNERA = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // outbound DENY self-gate
const OWNERB = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86'; // outbound ALLOW self-gate
const RECIP  = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // plain recipient (no controller)
const PUBKEY = 'a'.repeat(64);                        // 64-hex staking pubkey (format-valid)

const GATED1 = 'CPC1';  // mint->DENY, stake->DENY
const GATED2 = 'CPC2';  // mint->ALLOW, stake->ALLOW
const PLAIN  = 'CPCP';  // no controller, used for the outbound-self-gate sends
const T0     = 1700000000;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const DENY   = "module.exports={ guard:function(){ xchain.revert('policy denied'); } };";
const ALLOW  = "module.exports={ guard:function(){ return {}; } };";
const TARGET = "module.exports={ guard:function(){ return {}; }, noop:function(){} };"; // stakeable target

describe('Controller Phase C: MINT / STAKE / SOURCE-outbound (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer, denyIdx, allowIdx, targetIdx;

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
    // Count only VALID stake rows: a denied STAKE still writes its action record (with `invalid`
    // status), like every handler; the gating invariant is that no *valid* bond is locked.
    async function validStakeRows(tick) {
        return await indexerQuery(
            `SELECT s.amount FROM contract_stakes s
             JOIN index_tickers  it  ON it.id  = s.tick_id
             JOIN index_statuses ist ON ist.id = s.status_id
             WHERE it.tick = ? AND ist.status = 'valid'`, [tick]);
    }

    before(async function () {
        // This scenario drives real contract DEPLOY/EXECUTE, which needs the
        // isolated-vm-backed xchain-vm. The integration tier is provisioned
        // without a VM (EXECUTE paths are e2e-suite territory), so skip the whole
        // suite when xchain-vm can't be loaded rather than failing.
        try { require('xchain-vm'); } catch (e) { return this.skip(); }
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases();
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [OWNER, OWNERA, OWNERB], amount: '1000' });

        // Block 100: issue the tokens (GATED* are mintable: MAX_SUPPLY > MINT_SUPPLY) and deploy
        // the deny/allow guards + a stakeable target contract (DEPLOY v1, cooldown 100).
        await seeder.seedBlock(100, T0, [
            { source: OWNER, data: `ISSUE|0|${GATED1}|100000|10000|0|gated one|1000` },
            { source: OWNER, data: `ISSUE|0|${GATED2}|100000|10000|0|gated two|1000` },
            { source: OWNER, data: `ISSUE|0|${PLAIN}|1000|1000|0|plain token|1000` },
            { source: OWNER, data: `DEPLOY|0|${b64(DENY)}|300000|` },
            { source: OWNER, data: `DEPLOY|0|${b64(ALLOW)}|300000|` },
            { source: OWNER, data: `DEPLOY|1|${b64(TARGET)}|300000||100|` },
        ]);
        indexer = await initIndexer();
        await processBlocks(indexer);

        denyIdx   = await contractIndexByCode(DENY);
        allowIdx  = await contractIndexByCode(ALLOW);
        targetIdx = await contractIndexByCode(TARGET);

        // Block 101: distribute PLAIN to the two self-gating owners (ungated SEND from OWNER).
        await seeder.seedBlock(101, T0 + 100, [
            { source: OWNER, data: `SEND|0|${PLAIN}|200|${OWNERA}|seed-a` },
            { source: OWNER, data: `SEND|0|${PLAIN}|200|${OWNERB}|seed-b` },
        ]);
        await processBlocks(indexer);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await closeAll();
    });

    it('sets up tokens, guards, stakeable target, and seeds the self-gating owners', async function () {
        assert.ok(denyIdx,   'deny guard deployed');
        assert.ok(allowIdx,  'allow guard deployed');
        assert.ok(targetIdx, 'stakeable target deployed');
        assert.strictEqual(await balanceOf(OWNER,  GATED1), '1000', 'GATED1 minted to owner');
        assert.strictEqual(await balanceOf(OWNER,  GATED2), '1000', 'GATED2 minted to owner');
        assert.strictEqual(await balanceOf(OWNERA, PLAIN),  '200',  'OWNERA seeded with PLAIN');
        assert.strictEqual(await balanceOf(OWNERB, PLAIN),  '200',  'OWNERB seeded with PLAIN');
    });

    // --- 1. MINT guard ---
    it('a mint-class controller DENY reverts a MINT (no supply created)', async function () {
        await seeder.seedBlock(110, T0 + 1000, [
            { source: OWNER, data: `ISSUE|6|${GATED1}|${denyIdx}|mint|0|0|bind-mint-deny` },
        ]);
        await processBlocks(indexer);

        const before = await balanceOf(OWNER, GATED1);
        await seeder.seedBlock(111, T0 + 1100, [
            { source: OWNER, data: `MINT|0|${GATED1}|50` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(OWNER, GATED1), before,
            'MINT denied by the mint-class controller: balance unchanged');
    });

    it('a mint-class controller ALLOW commits a MINT and the block passes the supply sanity check', async function () {
        await seeder.seedBlock(112, T0 + 1200, [
            { source: OWNER, data: `ISSUE|6|${GATED2}|${allowIdx}|mint|0|0|bind-mint-allow` },
        ]);
        await processBlocks(indexer);

        const before = Number(await balanceOf(OWNER, GATED2));
        await seeder.seedBlock(113, T0 + 1300, [
            { source: OWNER, data: `MINT|0|${GATED2}|50` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(Number(await balanceOf(OWNER, GATED2)) - before, 50,
            'allowed MINT created 50 supply and the block committed (sanity passed)');
    });

    // --- 2. STAKE v3 guard ---
    it('a stake-class controller DENY reverts a v3 contract stake (no bond locked)', async function () {
        await seeder.seedBlock(120, T0 + 2000, [
            { source: OWNER, data: `ISSUE|6|${GATED1}|${denyIdx}|stake|0|0|bind-stake-deny` },
        ]);
        await processBlocks(indexer);

        const before = await balanceOf(OWNER, GATED1);
        await seeder.seedBlock(121, T0 + 2100, [
            { source: OWNER, data: `STAKE|3|100|${PUBKEY}|${targetIdx}|${GATED1}` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(OWNER, GATED1), before,
            'STAKE denied by the stake-class controller: bond not debited');
        const rows = await validStakeRows(GATED1);
        assert.strictEqual(rows.length, 0, 'no VALID contract_stakes row for the denied stake (bond not locked)');
    });

    it('a stake-class controller ALLOW commits a v3 stake and debits the bond', async function () {
        await seeder.seedBlock(122, T0 + 2200, [
            { source: OWNER, data: `ISSUE|6|${GATED2}|${allowIdx}|stake|0|0|bind-stake-allow` },
        ]);
        await processBlocks(indexer);

        const before = Number(await balanceOf(OWNER, GATED2));
        await seeder.seedBlock(123, T0 + 2300, [
            { source: OWNER, data: `STAKE|3|100|${PUBKEY}|${targetIdx}|${GATED2}` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(before - Number(await balanceOf(OWNER, GATED2)), 100,
            'allowed STAKE locked 100 of the bond and the block committed (sanity passed)');
    });

    // --- 3. SOURCE-outbound self-gate ---
    it("a SENDER's own transfer address-controller DENY reverts its OUTBOUND send", async function () {
        // OWNERA self-binds transfer -> deny. Its own outbound SEND of an ungated token must revert.
        await seeder.seedBlock(130, T0 + 3000, [
            { source: OWNERA, data: `ADDRESS|1|${denyIdx}|transfer|0|0|bind-out-deny` },
        ]);
        await processBlocks(indexer);

        const before = await balanceOf(RECIP, PLAIN);
        await seeder.seedBlock(131, T0 + 3100, [
            { source: OWNERA, data: `SEND|0|${PLAIN}|10|${RECIP}|outbound-blocked` },
        ]);
        await processBlocks(indexer);
        assert.strictEqual(await balanceOf(RECIP, PLAIN), before,
            'outbound SEND denied by the source self-gate: recipient uncredited');
        assert.strictEqual(await balanceOf(OWNERA, PLAIN), '200',
            "sender's balance unchanged (the outbound move never settled)");
    });

    it("a SENDER's own transfer address-controller ALLOW commits its OUTBOUND send (sanity passes)", async function () {
        // OWNERB self-binds transfer -> allow. Its outbound SEND settles and bills a guard fee
        // (GAS burn); the block must still pass the supply sanity check.
        await seeder.seedBlock(132, T0 + 3200, [
            { source: OWNERB, data: `ADDRESS|1|${allowIdx}|transfer|0|0|bind-out-allow` },
        ]);
        await processBlocks(indexer);

        const before = Number(await balanceOf(RECIP, PLAIN));
        await seeder.seedBlock(133, T0 + 3300, [
            { source: OWNERB, data: `SEND|0|${PLAIN}|10|${RECIP}|outbound-allowed` },
        ]);
        await processBlocks(indexer); // throws on SanityError if the guard-fee GAS burn desyncs supply
        assert.strictEqual(Number(await balanceOf(RECIP, PLAIN)) - before, 10,
            'allowed outbound SEND credited the recipient and the block committed (sanity passed)');
    });
});
