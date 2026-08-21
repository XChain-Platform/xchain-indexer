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
 * Integration: unstake cooldown completion must conserve GAS supply.
 *
 * STAKE debits the bond from SOURCE (a net removal from circulating supply) and
 * recomputes tokens.supply via updateTokens. When the cooldown elapses,
 * util.processCooldownCompletions credits the bond back (a net mint). It must
 * recompute tokens.supply too, or the per-block sanityCheck (ledger == supply ==
 * balances, run every block by the real XChainIndexer loop) trips on the GAS tick
 * and halts the indexer.
 *
 * REGRESSION: before the fix, processCooldownCompletions called updateBalances but
 * NOT updateTokens, so the release credit lifted the ledger + balances while the
 * GAS supply column stayed stale → ledger > supply → SanityError. This drives the
 * real completion path (faithful loop order: txs → processCooldownCompletions →
 * sanityCheck) and asserts the GAS supply invariant holds after a release.
 *
 * Run (disposable MariaDB):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_cd_decoder TEST_INDEXER_DB=cv_cd_indexer TEST_INDEXER_DB_B=cv_cd_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/20-cooldown-completion-supply.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');

const FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // configs/BTC.js ADDRESS.GAS (fee-exempt gas funder)
const A1     = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // valid regtest P2PKH (the staker)
const T = 1700000000;
const STAKE_BLOCK   = 100;
const UNSTAKE_BLOCK = 107;   // after the 6-block BTC activation delay
const STAKE_AMT     = '6000'; // > cross_chain MIN_STAKE (5000)

function genPubHex() {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return Buffer.from(der.slice(-32)).toString('hex');
}

describe('Unstake cooldown completion: GAS supply conservation (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    let seeder, indexer;
    const GAS = 'XCHAIN';
    const pubHex = genPubHex();

    async function balanceOf(address, tick) {
        const rows = await indexerQuery(
            `SELECT b.amount FROM balances b
             JOIN index_addresses ia ON ia.id = b.address_id
             JOIN index_tickers   it ON it.id = b.tick_id
             WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
        return rows.length ? String(rows[0].amount) : '0';
    }

    before(async function () {
        process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
        process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
        await createDatabases(__filename);
        await createDecoderSchema();
        seeder = new DecoderSeeder(decoderQuery);

        // Gas bootstrap (issuing/minting the gas tick is fee-exempt); A1 holds enough to bond.
        await seeder.seedBlock(99, T - 600, [
            { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap', txHash: 'b'.repeat(56) + '00000001' },
            { source: A1,     data: 'MINT|0|XCHAIN|10000',                              txHash: 'b'.repeat(56) + '00000002' },
        ]);
        // STAKE: debits 6000 XCHAIN from A1 (net removal from circulating supply).
        await seeder.seedBlock(STAKE_BLOCK, T, [{ source: A1, data: `STAKE|1|${STAKE_AMT}|${pubHex}` }]);
        // UNSTAKE (after activation): schedules the cooldown; no immediate ledger change.
        await seeder.seedBlock(UNSTAKE_BLOCK, T + 700, [{ source: A1, data: `UNSTAKE|0|${pubHex}` }]);

        indexer = await initIndexer();
        await processBlocks(indexer); // processes 99..107 (101-106 empty); sanity passes each block
    });

    after(async function () {
        if (indexer) await destroyIndexer(indexer);
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    it('stake debited the bond and the post-stake ledger is consistent', async function () {
        // A1 minted 10000, staked 6000 → 4000 left liquid.
        assert.strictEqual(await balanceOf(A1, GAS), '4000', 'A1 liquid GAS = minted − staked');
        const rows = await indexerQuery(
            `SELECT cooldown_end_block FROM unstakes u
             JOIN index_addresses a ON a.id = u.source_id WHERE a.address = ?`, [A1]);
        assert.ok(rows.length === 1, 'one capability unstake row recorded');
        assert.ok(Number(rows[0].cooldown_end_block) > UNSTAKE_BLOCK, 'cooldown_end_block scheduled in the future');
    });

    it('cooldown completion credits the bond back AND keeps GAS supply == ledger (no SanityError)', async function () {
        const ce = (await indexerQuery(
            `SELECT cooldown_end_block FROM unstakes u
             JOIN index_addresses a ON a.id = u.source_id WHERE a.address = ?`, [A1]))[0].cooldown_end_block;

        const liquidBefore = Number(await balanceOf(A1, GAS));

        // Drive the real completion path at the cooldown-end block (loop order: the block's txs
        // already ran in processBlocks; now completions, then the per-block sanity check).
        await indexer.indexerDb.beginTransaction();
        try {
            await indexer.util.processCooldownCompletions(indexer.actions, indexer.indexerDb, Number(ce));
            // With UNSTAKE_COOLDOWN_COMPLETION_ACTION active (regtest genesis), the release
            // credit is recorded against a fresh synthetic UNSTAKE (format 2) action minted at
            // the cooldown-end block, so it hashes into that block. sanityCheck on the cooldown
            // block re-derives GAS supply: pre-fix the supply column was stale (ledger > supply)
            // and this throws SanityError; post-fix updateTokens reconciles it.
            await indexer.indexerDb.sanityCheck(Number(ce));
            await indexer.indexerDb.commitTransaction();
        } catch (e) {
            await indexer.indexerDb.rollbackTransaction();
            throw e;
        }

        // The bond returned to A1's liquid balance...
        assert.strictEqual(Number(await balanceOf(A1, GAS)) - liquidBefore, Number(STAKE_AMT),
            'released bond credited back to the staker');

        // F-21: the return credit must hash into the COOLDOWN block, not the UNSTAKE's origin
        // block. Assert the credit's action lives at the cooldown-end block (via a synthetic
        // UNSTAKE completion action) rather than at UNSTAKE_BLOCK. This is the property that
        // makes ledger_hash agree with balances_root and with a recompute-from-final-state.
        const creditActionBlocks = await indexerQuery(
            `SELECT DISTINCT act.block_index AS b
             FROM credits c
                 JOIN actions act ON act.action_index = c.action_index
                 JOIN index_addresses a ON a.id = c.address_id
                 JOIN index_tickers   t ON t.id = c.tick_id
             WHERE a.address = ? AND t.tick = ?`, [A1, GAS]);
        const blocks = creditActionBlocks.map(r => Number(r.b));
        assert.ok(blocks.includes(Number(ce)),
            `return credit must be attributed to the cooldown block ${Number(ce)} (got blocks ${blocks.join(',')})`);
        assert.ok(!blocks.includes(UNSTAKE_BLOCK),
            `return credit must NOT be attributed to the UNSTAKE origin block ${UNSTAKE_BLOCK} (got ${blocks.join(',')})`);
        // ...and the FULL three-way supply invariant holds: tokens.supply == ledger
        // (credits-debits+escrows) == balances. The synthetic UNSTAKE completion is a
        // NET-MINT credit on a tx_index=NULL action, so getTokenSupply must count
        // synthetic-action credits (it previously INNER JOINed transactions and dropped
        // them, leaving balances 500 higher than the ledger and wedging sanityCheck at
        // the next real-tx block). Comparing balance to ledger here is the check that a
        // ledger-vs-token-only assertion missed (both were computed the same buggy way).
        // bcnum-normalize like the production consumer (sanityCheck): getTokenSupply
        // returns a bcmath-normalized string ("10000") while the Token/Balance getters
        // return the raw SQL DECIMAL string ("10000.00000000"); the invariant is about
        // value, not formatting.
        const bc      = (v) => String(indexer.indexerDb.util.bcnum(v));
        const ledger  = bc(await indexer.indexerDb.getTokenSupply(GAS));
        const token   = bc(await indexer.indexerDb.getTokenSupplyToken(GAS));
        const balance = bc(await indexer.indexerDb.getTokenSupplyBalance(GAS));
        assert.strictEqual(ledger, token,   'GAS ledger supply == tokens.supply after the release');
        assert.strictEqual(balance, ledger, 'GAS balances supply == ledger supply (synthetic-credit counted)');

        // And sanityCheck on the cooldown block itself must now find + validate GAS: the
        // touched-tick scan is scoped by the action's block_index, so a synthetic-only
        // completion block is no longer skipped. This throws SanityError on regression.
        await indexer.indexerDb.sanityCheck(Number(ce));
    });
});
