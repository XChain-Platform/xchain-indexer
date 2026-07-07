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
 * Integration: cross-chain DEX royalty enforcement (finding B), real MariaDB + real
 * isolated-vm guard. Design: claude/reports/2026-07-07_cross-chain-royalty-design.md
 *
 * Proves, over real DB rows + a real guard VM + a real Ed25519-signed match:
 *   1. CREATE (propagate): a cross-chain ORDER of a trade-controlled token whose guard
 *      returns payout legs is ACCEPTED (CROSS_CHAIN_ROYALTY genesis-active on regtest)
 *      and the legs land on the orders row (the hub's open-order feed reads them).
 *   2. CREATE (deny): a leg that cannot re-encode to GET_COIN (segwit leg, GET_COIN=DOGE,
 *      which has no bech32) DENIES the listing; no escrow moves.
 *   3. SETTLE (apply): a validator-signed cross_chain_matches row carrying the
 *      counterparty's legs settles this chain's escrow as seller remainder + re-encoded
 *      leg credit (applyProceedsSplit), and a row with STRIPPED legs fails signature
 *      verification (legs are inside the signed canonical) so nothing settles.
 *
 * COIN MUST be LTC (off-BTC): cross_settle resolves the cross_chain validator set from
 * the mirrored capability_snapshots on non-BTC chains, which this test injects directly;
 * on BTC it derives from real local capability stakes.
 *
 * Run (Mac-native; the NFS isolated-vm binary is arm64 Mach-O, see the handover recipe):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 TEST_DB_USER=<u> TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_x_decoder TEST_INDEXER_DB=cv_x_indexer TEST_INDEXER_DB_B=cv_x_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=LTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/26-cross-chain-royalty.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');

const OWNER   = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues, binds, lists
const LEGADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'; // royalty leg recipient
const CPARTY  = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // counterparty's receive addr on THIS chain
const GETADDR = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // seller's receive addr on the GET chain
// A real regtest segwit (bech32) address: valid locally, NOT portable to DOGE (no HRP)
const SEGLEG_ADDR = 'rltc1qjvuwa4wxg2cvxxkt9hacuujeweamzpu8gs3cvg';

const CBTR = 'CBTR';  // trade-controlled, portable p2pkh leg → cross-chain listing accepted
const CBTS = 'CBTS';  // trade-controlled, segwit leg → DOGE listing denied
const PLNA = 'PLNA';  // plain token, escrowed by the order the injected match settles
const T0   = 1700000000;
const EXP  = T0 + 86400 * 30;
const SNAP = 200;     // BTC-anchored snapshot_block for the injected match
const b64  = s => Buffer.from(s, 'utf8').toString('base64');
const sha  = s => crypto.createHash('sha256').update(s).digest('hex');

const ROYAL  = `module.exports={ guard:function(){ return { payoutLegs: [{ to: '${LEGADDR}', bps: 2500 }] }; } };`;
const SEGLEG = `module.exports={ guard:function(){ return { payoutLegs: [{ to: '${SEGLEG_ADDR}', bps: 2500 }] }; } };`;

// The production canonical builder (cross_settle._canonical): the injected match must be
// signed over the EXACT bytes the settlement pass verifies, legs included.
const Cross_Settle = require('../../../src/actions/cross_settle.js');
const settleCanon  = new Cross_Settle({ config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null });

function genValidator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    return { pubkey, privateKey };
}

describe('Cross-chain royalty: create-side gate + signed-legs settlement (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer, royalIdx, segIdx, sellOrderIdx, plainOrderIdx;

    async function contractIndexByCode(code) {
        const h = sha(code);
        const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
        const r = rows.find(x => x.code_hash === h);
        return r ? Number(r.action_index) : null;
    }
    async function orderRow(actionIndex) {
        const rows = await indexerQuery(
            'SELECT o.payout_legs FROM orders o WHERE o.action_index = ?', [actionIndex]);
        return rows.length ? rows[0] : null;
    }
    async function orderStatus(actionIndex) {
        const rows = await indexerQuery(
            `SELECT st.status FROM order_statuses os
             JOIN index_statuses st ON st.id = os.status_id
             WHERE os.order_action_index = ? ORDER BY os.action_index DESC LIMIT 1`, [actionIndex]);
        return rows.length ? String(rows[0].status) : null;
    }
    async function orderIndexByMemo(memo) {
        const rows = await indexerQuery(
            `SELECT a.action_index AS ai FROM actions a
             JOIN transactions t ON t.tx_index = a.tx_index
             WHERE t.data LIKE ? ORDER BY a.action_index ASC LIMIT 1`, ['%' + memo + '%']);
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
        // Off-BTC on purpose (see header): the injected capability_snapshots rows are the
        // validator set cross_settle verifies the match signatures against.
        process.env.INDEXER_COIN    = 'LTC';
        process.env.INDEXER_NETWORK = 'regtest';
        await createDatabases();
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);
        await seedGas(seeder, { addresses: [OWNER], amount: '1000' });

        // Block 100: issue the three tokens + deploy both guards.
        await seeder.seedBlock(100, T0, [
            { source: OWNER, data: `ISSUE|0|${CBTR}|100000|10000|0|royalty token|1000` },
            { source: OWNER, data: `ISSUE|0|${CBTS}|100000|10000|0|segwit-leg token|1000` },
            { source: OWNER, data: `ISSUE|0|${PLNA}|100000|10000|0|plain token|1000` },
            { source: OWNER, data: `DEPLOY|0|${b64(ROYAL)}|300000|` },
            { source: OWNER, data: `DEPLOY|0|${b64(SEGLEG)}|300000|` },
        ]);
        indexer = await initIndexer();
        // LTC is native-fee-only; this scenario is about royalty legs, not fee mode, so pin
        // the xchain-balance fee path (scenario 11's forceXchainFeeMode: a placeholder
        // FEE_DESTINATION short-circuits detectFeePaymentMode to 'xchain'; the config
        // snapshot is shared with util, so one mutation covers both).
        indexer.config.ADDRESS.FEE_DESTINATION = 'X'.repeat(34);
        await processBlocks(indexer);
        royalIdx = await contractIndexByCode(ROYAL);
        segIdx   = await contractIndexByCode(SEGLEG);
        assert.ok(royalIdx && segIdx, 'both guards deployed');

        // Block 101: bind the trade class of each gated token to its guard.
        await seeder.seedBlock(101, T0 + 100, [
            { source: OWNER, data: `ISSUE|6|${CBTR}|${royalIdx}|trade|0|0|bind-trade-royal` },
            { source: OWNER, data: `ISSUE|6|${CBTS}|${segIdx}|trade|0|0|bind-trade-segleg` },
        ]);
        await processBlocks(indexer);
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await closeAll();
    });

    it('1. cross-chain listing of a royalty token is ACCEPTED and the legs ride the order row', async function () {
        await seeder.seedBlock(102, T0 + 200, [
            { source: OWNER, data: `ORDER|0|LTC|${CBTR}|100||BTC|WANTB|50||${GETADDR}|${EXP}|||xcr-sell` },
        ]);
        await processBlocks(indexer);
        sellOrderIdx = await orderIndexByMemo('xcr-sell');
        assert.ok(sellOrderIdx, 'sell order found');
        assert.strictEqual(await orderStatus(sellOrderIdx), 'open');
        const row = await orderRow(sellOrderIdx);
        assert.deepStrictEqual(JSON.parse(row.payout_legs), [{ to: LEGADDR, bps: 2500 }]);
        // Escrowed: OWNER's CBTR dropped by the listed amount
        assert.strictEqual(await balanceOf(OWNER, CBTR), '900');
    });

    it('2. a leg that cannot re-encode to GET_COIN DENIES the listing (fail-closed)', async function () {
        await seeder.seedBlock(103, T0 + 300, [
            { source: OWNER, data: `ORDER|0|LTC|${CBTS}|100||DOGE|WANTD|50||${GETADDR}|${EXP}|||xcr-deny` },
        ]);
        await processBlocks(indexer);
        const denyIdx = await orderIndexByMemo('xcr-deny');
        assert.ok(denyIdx, 'deny order action found');
        assert.notStrictEqual(await orderStatus(denyIdx), 'open');
        // Nothing escrowed: balance intact
        assert.strictEqual(await balanceOf(OWNER, CBTS), '1000');
    });

    it('3. a signed match carrying counterparty legs settles as remainder + re-encoded leg credit; stripped legs do not verify', async function () {
        // Open the plain cross-chain order whose escrow the match will settle.
        await seeder.seedBlock(104, T0 + 400, [
            { source: OWNER, data: `ORDER|0|LTC|${PLNA}|100||BTC|FOO|50||${GETADDR}|${EXP}|||xcr-plain` },
        ]);
        await processBlocks(indexer);
        plainOrderIdx = await orderIndexByMemo('xcr-plain');
        assert.strictEqual(await orderStatus(plainOrderIdx), 'open');

        // Single validator with a snapshot weight (stake-weighted quorum: 3w > 2w for N=1).
        const v = genValidator();
        await indexerQuery(
            `INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source)
             VALUES (?, 'cross_chain', ?, '5', 'srcA')`, [SNAP, v.pubkey]);

        // The counterparty (BTC side, leg a) sold a controlled token there; its legs are in
        // BTC regtest encoding and apply to the proceeds THIS chain releases (b's escrow →
        // a_payout_addr). BTC/LTC regtest share the p2pkh prefix, so the re-encode is the
        // identity here; the mainnet byte-swap is pinned by address-reencode.test.js.
        const A_LEGS = JSON.stringify([{ to: LEGADDR, bps: 2500 }]);
        const makeRow = (matchId, legs) => ({
            match_id: matchId, snapshot_block: SNAP, network: 'regtest',
            a_chain: 'BTC', a_action_index: 424242, a_kind: 'order', a_tick: 'FOO', a_amount: '50',
            a_filled_before: '0', a_ownership: 0, a_payout_addr: CPARTY, a_payout_legs: legs,
            b_chain: 'LTC', b_action_index: plainOrderIdx, b_kind: 'order', b_tick: PLNA, b_amount: '100',
            b_filled_before: '0', b_ownership: 0, b_payout_addr: GETADDR, b_payout_legs: null,
            effective_time: T0 + 450, finalizing_view: 0
        });
        const insertMatch = async (m, sigs) => indexerQuery(
            `INSERT INTO cross_chain_matches
                (match_id, snapshot_block, network,
                 a_chain, a_action_index, a_kind, a_tick, a_amount, a_filled_before, a_ownership, a_payout_addr, a_payout_legs,
                 b_chain, b_action_index, b_kind, b_tick, b_amount, b_filled_before, b_ownership, b_payout_addr, b_payout_legs,
                 effective_time, finalizing_view, validator_signatures, status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalized')`,
            [m.match_id, m.snapshot_block, m.network,
             m.a_chain, m.a_action_index, m.a_kind, m.a_tick, m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.a_payout_legs,
             m.b_chain, m.b_action_index, m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr, m.b_payout_legs,
             m.effective_time, m.finalizing_view, JSON.stringify(sigs)]);

        // (a) Tamper control: sign WITH legs, store WITHOUT them → the canonical no longer
        // matches the signature, so the settlement pass must refuse to settle.
        const tampered = makeRow('a'.repeat(64), A_LEGS);
        const tamperedSig = crypto.sign(null, Buffer.from(settleCanon._canonical(tampered), 'utf8'), v.privateKey).toString('hex');
        tampered.a_payout_legs = null;             // strip AFTER signing
        await insertMatch(tampered, [{ pubkey: v.pubkey, sig: tamperedSig }]);

        // (b) The honest match: signed over the legs-bearing canonical, stored intact.
        const honest = makeRow('b'.repeat(64), A_LEGS);
        const honestSig = crypto.sign(null, Buffer.from(settleCanon._canonical(honest), 'utf8'), v.privateKey).toString('hex');
        await insertMatch(honest, [{ pubkey: v.pubkey, sig: honestSig }]);

        // Any next block triggers the settlement pass.
        await seeder.seedBlock(105, T0 + 500, [
            { source: OWNER, data: `BROADCAST|0|tick` },
        ]);
        await processBlocks(indexer);

        // The tampered match settled nothing; the honest one split 100 PLNA into 75 + 25.
        const settled = await indexerQuery('SELECT match_id FROM cross_chain_settlements', []);
        const settledIds = settled.map(r => String(r.match_id));
        assert.ok(!settledIds.includes('a'.repeat(64)), 'stripped-legs match must NOT settle');
        assert.ok(settledIds.includes('b'.repeat(64)), 'honest match settles');
        assert.strictEqual(await balanceOf(CPARTY, PLNA), '75', 'seller remainder');
        assert.strictEqual(await balanceOf(LEGADDR, PLNA), '25', 'royalty leg credit');
        assert.strictEqual(await orderStatus(plainOrderIdx), 'complete');
    });
});
