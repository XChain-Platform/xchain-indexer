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
 * Integration tests — 14: MULTI-CHAIN FULL-STATE PARITY (P3, test-framework
 * program)
 *
 * The protocol's promise: action processing is chain-parameterized only
 * through the per-coin configs — identical input must produce IDENTICAL
 * indexer state on BTC, LTC and DOGE, down to the consensus hash chain.
 *
 * Scenario 11 asserts this for a 4-field projection of ISSUE/MINT/SEND.
 * This suite asserts it for the ENTIRE database over a rich corpus (ORDER
 * match, ORDER expiry, permitted DISPENSER escrow, DESTROY, cross-sends):
 * one fresh indexer run per coin via withCoin, full-state capture after
 * each, then byte-level cross-coin comparison plus resolved hash-chain
 * equality. A chain-dependence bug anywhere in action processing (fee
 * math, status assignment, expiration ordering, escrow handling) lands in
 * the diff with table + row detail.
 *
 * The corpus is chain-agnostic BY CONSTRUCTION:
 *   - the give/get coin field in ORDER/DISPENSER strings is the RUN's own
 *     coin, so both legs stay local on every chain (a hardcoded foreign
 *     coin would make the order cross-chain on two of the three runs).
 *   - chain-GATED actions (BTC-only capability staking) are excluded;
 *     scenario 11 covers the gates themselves.
 *   - every coin is pinned to the xchain-balance fee path via the
 *     documented placeholder-destination override (same premise as
 *     scenario 11: LTC/DOGE are native-fee-only with a real destination,
 *     which would reject fee-bearing actions absent fee outputs).
 *
 * Exactly THREE per-chain artifacts remain, all normalized (not ignored)
 * before comparison — anything else that differs is a chain-dependence bug:
 *   1. transactions.data stores the raw ACTION string, which contains the
 *      run's coin literal (ORDER/DISPENSER give+get fields).
 *   2. index_coins holds that same literal as the deduped coin row.
 *   3. index_addresses holds the chain's own special addresses (the ISSUE
 *      fee is credited to the per-coin DONATE1 constant from config.ADDRESS).
 *      Their POSITIONS (ids) must still match — referencing rows compare raw.
 *
 * NOTE: this parity holds only in the UNIFIED_FEES era (active since 2.0.0).
 * The pre-2.0.0 LEGACY fee constants are per-coin BY DESIGN (BTC issuance
 * 1.0 vs LTC 0.5 XCHAIN), so the running version matters — the launcher
 * defaults npm_package_version to the real package version precisely so
 * direct-mocha and npm invocations both run in the shipping era.
 */

'use strict';

const assert = require('assert');
const {
    indexerQuery, createDatabases, createDecoderSchema, closeAll,
} = require('../setup/db-connection');
const { COINS, withCoin, processBlocks } = require('../setup/multi-chain');
const { seedGas, GAS_FUNDER } = require('../setup/gas-seeder');
const { assertStateInvariants } = require('../setup/state-invariants');
const { readHashChain, assertHashChainsEqual, captureDbState,
        assertCapturedStatesEqual } = require('../setup/equivalence');

const ADDR1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const ADDR2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';
const ADDR3 = 'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3';

const T0  = 1700000000;
const BLK = 600;
const T_FAR_FUTURE = T0 + 86400 * 30;
const T_EXPIRY     = T0 + BLK * 5 + 60; // between blocks 105 and 106 -> the
                                        // unmatched order expires at block 106
                                        // on every chain alike

// Rich, deterministic corpus, parameterized ONLY by the run's coin literal.
function corpus(coin) {
    return [
        { block: 100, time: T0,           txs: [{ source: ADDR1, data: 'ISSUE|0|MPTA|1000000|1000|0|multi-chain parity A' }] },
        { block: 101, time: T0 + BLK,     txs: [{ source: ADDR2, data: 'ISSUE|0|MPTB|500000|500|0|multi-chain parity B' }] },
        { block: 102, time: T0 + BLK * 2, txs: [
            { source: ADDR1, data: 'MINT|0|MPTA|800' },
            { source: ADDR2, data: 'MINT|0|MPTB|400' },
        ] },
        { block: 103, time: T0 + BLK * 3, txs: [
            { source: ADDR1, destination: ADDR2, data: 'SEND|0|MPTA|150|' + ADDR2 },
            { source: ADDR2, destination: ADDR1, data: 'SEND|0|MPTB|75|' + ADDR1 },
        ] },
        { block: 104, time: T0 + BLK * 4, txs: [
            { source: ADDR1, data: 'ORDER|0|' + coin + '|MPTA|10|0|' + coin + '|MPTB|20|0|' + ADDR1 + '|' + T_FAR_FUTURE + '|||' },
            { source: ADDR2, data: 'ORDER|0|' + coin + '|MPTB|20|0|' + coin + '|MPTA|10|0|' + ADDR2 + '|' + T_FAR_FUTURE + '|||' },
            // Unmatchable order -> exercises ORDER_EXPIRE at block 106.
            { source: ADDR1, data: 'ORDER|0|' + coin + '|MPTA|5|0|' + coin + '|MPTB|999|0|' + ADDR1 + '|' + T_EXPIRY + '|||' },
        ] },
        { block: 105, time: T0 + BLK * 5, txs: [
            { source: ADDR3, data: 'ADDRESS|0|||2|' },
            { source: ADDR1, data: 'DISPENSER|0|' + coin + '|MPTA|10|0|50|' + coin + '|MPTB|1|' + ADDR3 + '||||' + T_FAR_FUTURE + '|||' },
        ] },
        { block: 106, time: T0 + BLK * 6, txs: [{ source: ADDR1, data: 'MINT|0|MPTA|40' }] },
        { block: 107, time: T0 + BLK * 7, txs: [{ source: ADDR1, data: 'DESTROY|0|MPTA|20|burning tokens' }] },
    ];
}
const CORPUS_BLOCKS = 9; // gas preamble + 100..107

describe('14 – Multi-chain full-state parity @regression @tier1', function () {
    this.timeout(180000);

    const envKeys = COINS.map(c => `XCHAIN_FEE_DESTINATION_${c}_REGTEST`);
    const states = {};
    const chains = {};

    // Normalize the three documented per-chain artifacts (see header) so the
    // remaining comparison is exhaustive.
    function normalizeState(state, coin, specialAddresses) {
        const out = { ...state };
        // Re-sort each transformed table: captures are sorted canonical
        // strings, and replacement can change the order.
        out.transactions = state.transactions.map(s =>
            s.split('|' + coin + '|').join('|<COIN>|')).sort();
        out.index_coins = state.index_coins.map(s =>
            s.replace('"' + coin + '"', '"<COIN>"')).sort();
        out.index_addresses = state.index_addresses.map(s => {
            // The harness's gas-bootstrap funder happens to BE the BTC
            // regtest GAS address — normalize it FIRST so the BTC run does
            // not collapse it into <GAS> while other coins keep it raw.
            s = s.replace('"' + GAS_FUNDER + '"', '"<GAS_FUNDER>"');
            for (const [key, addr] of Object.entries(specialAddresses)) {
                s = s.replace('"' + addr + '"', '"<' + key + '>"');
            }
            return s;
        }).sort();
        return out;
    }

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
        // Pin every coin to the xchain-balance fee path (see header).
        for (const k of envKeys) process.env[k] = 'X'.repeat(34);

        for (const coin of COINS) {
            await withCoin(coin, 'regtest', async ({ seeder, indexer }) => {
                await seedGas(seeder, { addresses: [ADDR1, ADDR2, ADDR3] });
                for (const b of corpus(coin)) await seeder.seedBlock(b.block, b.time, b.txs);
                const processed = await processBlocks(indexer);
                assert.strictEqual(processed, CORPUS_BLOCKS,
                    `${coin}: expected ${CORPUS_BLOCKS} blocks, processed ${processed}`);
                await assertStateInvariants(indexerQuery);
                states[coin] = normalizeState(
                    await captureDbState(indexerQuery), coin,
                    (indexer.config && indexer.config.ADDRESS) || {});
                chains[coin] = await readHashChain(indexerQuery);
            });
        }
    });

    after(async function () {
        for (const k of envKeys) delete process.env[k];
        await closeAll();
    });

    it('the corpus exercised matches, expiries and escrows on every chain', function () {
        for (const coin of COINS) {
            const actions = states[coin].index_actions.join(' ');
            for (const sys of ['ORDER_MATCH', 'ORDER_EXPIRE', 'DISPENSER', 'DESTROY']) {
                assert.ok(actions.includes(sys),
                    `${coin}: corpus never produced a ${sys} action — parity would be vacuous`);
            }
        }
    });

    it('LTC full state is byte-identical to BTC (modulo the 3 normalized artifacts)', function () {
        assertCapturedStatesEqual(states.BTC, states.LTC, { labelA: 'BTC', labelB: 'LTC' });
    });

    it('DOGE full state is byte-identical to BTC (modulo the 3 normalized artifacts)', function () {
        assertCapturedStatesEqual(states.BTC, states.DOGE, { labelA: 'BTC', labelB: 'DOGE' });
    });

    it('the consensus hash chains are identical across all three chains', function () {
        assertHashChainsEqual(chains.BTC, chains.LTC, 'BTC', 'LTC');
        assertHashChainsEqual(chains.BTC, chains.DOGE, 'BTC', 'DOGE');
    });
});
