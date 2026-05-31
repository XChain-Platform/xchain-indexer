/**
 * Integration test: MULTI-CHAIN action processing (BTC / LTC / DOGE).
 *
 * The indexer integration suite otherwise runs BTC-only (INDEXER_COIN defaults to BTC and no
 * scenario loops over chains). This sweeps all three protocol coins to assert:
 *
 *   1. CHAIN-AGNOSTIC CORE — the ISSUE/MINT/SEND lifecycle produces byte-identical ledger state
 *      on BTC, LTC and DOGE (the common path must not silently depend on the chain).
 *   2. CAPABILITY-STAKING is BTC-ONLY — a v1 capability STAKE is rejected as
 *      `invalid: ACTION (BTC only)` on LTC/DOGE but not on BTC (src/actions/stake.js:85).
 *   3. FEE-PAYMENT MODE per chain — BTC falls back to xchain-balance when no native fee output
 *      is present; LTC/DOGE require the native output (src/utility.js detectFeePaymentMode).
 *
 * Looping coins in one process is safe because config.getConfig() re-reads INDEXER_COIN each call
 * (no memoization) and address validation is chain-agnostic — see test/integration/setup/multi-chain.js.
 *
 * Run with the disposable test DB (handoff runbook):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=13307 TEST_DB_USER=root TEST_DB_PASS=mvhtest \
 *   INDEXER_COIN=BTC INDEXER_NETWORK=regtest npx mocha --no-config test/integration/scenarios/11-multi-chain.test.js
 */

'use strict';

const assert = require('assert');
const { indexerQuery, createDatabases, createDecoderSchema, closeAll } = require('../setup/db-connection');
const { getToken, getLastActionIndexByType } = require('../setup/assertion-helpers');
const { COINS, withCoin, processBlocks } = require('../setup/multi-chain');
const Utility = require('../../../src/utility.js');

const A1 = 'mMcAddr1XXXXXXXXXXXXXXXXXXXXX1'; // 30 chars
const A2 = 'mMcAddr2XXXXXXXXXXXXXXXXXXXXX2';
const T  = 1700000000;

async function balanceOf(address, tick) {
    const r = await indexerQuery(
        `SELECT b.amount FROM balances b
         INNER JOIN index_addresses a ON a.id = b.address_id
         INNER JOIN index_tickers   t ON t.id = b.tick_id
         WHERE a.address = ? AND t.tick = ?`,
        [address, tick]
    );
    return r.length ? r[0].amount : null;
}

describe('Multi-chain action processing @regression @tier1', function () {
    this.timeout(120000);

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });
    after(async function () {
        await closeAll();
    });

    // -----------------------------------------------------------------------
    // 1. Chain-agnostic core lifecycle.
    // -----------------------------------------------------------------------
    it('ISSUE/MINT/SEND lifecycle produces identical ledger state on BTC, LTC and DOGE', async function () {
        const results = {};
        for (const coin of COINS) {
            results[coin] = await withCoin(coin, 'regtest', async ({ seeder, indexer }) => {
                await seeder.seedBlock(100, T,        [{ source: A1, data: 'ISSUE|0|MCTOK|100000|1000|0|multi-chain token' }]);
                await seeder.seedBlock(101, T + 600,  [{ source: A1, data: 'MINT|0|MCTOK|500' }]);
                await seeder.seedBlock(102, T + 1200, [{ source: A1, destination: A2, data: 'SEND|0|MCTOK|200|' + A2 }]);
                await processBlocks(indexer);
                const tok = await getToken(indexerQuery, 'MCTOK');
                return {
                    supply: tok ? tok.supply : null,
                    balA1: await balanceOf(A1, 'MCTOK'),
                    balA2: await balanceOf(A2, 'MCTOK'),
                };
            });
        }

        // Chain-agnostic: every coin must derive the same ledger.
        assert.deepStrictEqual(results.LTC,  results.BTC, 'LTC ledger differs from BTC for identical input');
        assert.deepStrictEqual(results.DOGE, results.BTC, 'DOGE ledger differs from BTC for identical input');
        // And the lifecycle actually did something (SEND moved 200 to A2).
        assert.strictEqual(results.BTC.balA2, '200', 'expected 200 MCTOK sent to A2');
    });

    // -----------------------------------------------------------------------
    // 2. Capability staking is BTC-only.
    // -----------------------------------------------------------------------
    it('capability STAKE (v1) is rejected as BTC-only on LTC/DOGE, accepted on BTC', async function () {
        const PUBKEY = '02' + 'ab'.repeat(32); // 66-char compressed pubkey
        for (const coin of COINS) {
            const status = await withCoin(coin, 'regtest', async ({ seeder, indexer }) => {
                await seeder.seedBlock(100, T, [{ source: A1, data: 'STAKE|1|100|' + PUBKEY }]);
                await processBlocks(indexer);
                const idx = await getLastActionIndexByType(indexerQuery, 'STAKE');
                assert.ok(idx !== null, `${coin}: STAKE action was not recorded`);
                const r = await indexerQuery(
                    `SELECT s.status FROM stakes st INNER JOIN index_statuses s ON s.id = st.status_id
                     WHERE st.action_index = ?`, [idx]);
                return r.length ? r[0].status : null;
            });

            if (coin === 'BTC') {
                assert.notStrictEqual(status, 'invalid: ACTION (BTC only)',
                    'BTC must NOT hit the BTC-only capability-staking gate');
            } else {
                assert.strictEqual(status, 'invalid: ACTION (BTC only)',
                    `${coin}: capability STAKE must be rejected as BTC-only`);
            }
        }
    });

    // -----------------------------------------------------------------------
    // 3. Fee-payment mode per chain (behavioral test of detectFeePaymentMode).
    //
    // NOTE: FEE_DESTINATION is the pre-launch placeholder on every network today, which makes
    // detectFeePaymentMode short-circuit to 'xchain' for ALL coins (utility.js:598). We document
    // that current state AND pin the intended post-launch per-chain branch by injecting a real
    // fee destination — so the behavior is already covered when the launch address is set.
    // -----------------------------------------------------------------------
    describe('fee-payment mode', function () {
        const FEE_DEST = 'mFeeDestXXXXXXXXXXXXXXXXXXXXXX9'; // any real (non-placeholder) address

        function utilFor(coin) {
            process.env.INDEXER_COIN    = coin;
            process.env.INDEXER_NETWORK = 'regtest';
            return new Utility();
        }

        it('pre-launch placeholder FEE_DESTINATION short-circuits to xchain on every coin', function () {
            for (const coin of COINS) {
                const util = utilFor(coin); // keeps the placeholder destination
                assert.strictEqual(util.detectFeePaymentMode({ COIN: coin }, null, []), 'xchain',
                    `${coin}: placeholder fee destination should fall back to xchain`);
            }
        });

        it('with a real fee destination and NO fee output: BTC=xchain, LTC/DOGE=rejected', function () {
            for (const coin of COINS) {
                const util = utilFor(coin);
                util.config['ADDRESS']['FEE_DESTINATION'] = FEE_DEST;
                const mode = util.detectFeePaymentMode({ COIN: coin }, null, []);
                if (coin === 'BTC') {
                    assert.strictEqual(mode, 'xchain', 'BTC should fall back to xchain when no native fee output');
                } else {
                    assert.strictEqual(mode, 'rejected', `${coin} requires a native fee output (no xchain fallback)`);
                }
            }
        });

        it('with a fee output present: native on every coin', function () {
            for (const coin of COINS) {
                const util = utilFor(coin);
                util.config['ADDRESS']['FEE_DESTINATION'] = FEE_DEST;
                const mode = util.detectFeePaymentMode({ COIN: coin }, null, [{ address: FEE_DEST }]);
                assert.strictEqual(mode, 'native', `${coin}: a fee output to the destination is native payment`);
            }
        });
    });
});
