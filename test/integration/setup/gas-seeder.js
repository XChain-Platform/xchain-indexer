'use strict';

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
 * Gas seeding preamble for the fee era.
 *
 * ISSUANCE_FEE is active from block 0 on regtest, so any scenario that
 * ISSUEs a token needs its source address to hold XCHAIN (the gas tick)
 * first, mirroring the live e2e suites' "seed gas for fresh addresses"
 * convention. Issuing the gas tick itself is fee-exempt (gasBootstrap in
 * actions/issue.js), and regtest exempts the official-GAS-address-only
 * issuer rule, so the preamble is fully self-contained:
 *
 *   block <blockIndex>:  ISSUE XCHAIN (bootstrap, no fee)
 *                        MINT  XCHAIN to each test address
 *
 * Seed this BEFORE the scenario's own blocks (default block 99, directly
 * below the conventional 100 start): one processBlocks() pass then handles
 * gas + scenario blocks in order, so callers only add this one line to
 * beforeEach. Contiguity matters: the indexer walks every index between
 * its first and last decoder block, so a gap (e.g. gas at 90, scenario at
 * 100) would add phantom empty blocks 91-99 to block counts.
 *
 * Costs for sizing `amount`: ISSUE = 100000 gas × 0.00001 = 1 XCHAIN;
 * other actions are db-hit priced and far cheaper. The default 100 XCHAIN
 * per address covers any scenario in this tier.
 */

const GAS_TICK = 'XCHAIN';

// The canonical regtest GAS address (configs/BTC.js → ADDRESS.GAS for
// regtest). Regtest allows any issuer, but using the real one keeps the
// preamble identical in shape to mainnet/testnet history.
const GAS_FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';

// MAX_MINT must be >= the per-address seed amount; MAX_SUPPLY just needs
// headroom for every MINT in a scenario run.
const GAS_ISSUE = `ISSUE|0|${GAS_TICK}|21000000|1000|8|Gas bootstrap`;

/**
 * Seed the gas bootstrap block: ISSUE XCHAIN + MINT `amount` to each address.
 * @param {DecoderSeeder} seeder
 * @param {object} opts { blockIndex=99, blockTime=1699999000, addresses=[], amount='100' }
 *                 Pass blockIndex explicitly when the scenario's blocks do
 *                 not start at 100; keep it contiguous (first block - 1).
 */
async function seedGas(seeder, opts = {}) {
    const blockIndex = opts.blockIndex || 99;
    const blockTime  = opts.blockTime  || 1699999000;
    const addresses  = opts.addresses  || [];
    const amount     = opts.amount     || '100';

    // Explicit tx hashes in a 'b'-prefixed space: the seeder's auto-generated
    // hashes and several tests' hand-pinned hashes both live in 'aaa...NN',
    // so colliding there reuses a tx_hash_id and trips the transactions table's
    // UNIQUE key (observed via 06's determinism test).
    const txs = [{ source: GAS_FUNDER, data: GAS_ISSUE,
                   txHash: 'b'.repeat(56) + '00000001' }];
    let n = 2;
    for (const addr of addresses)
        txs.push({ source: addr, data: `MINT|0|${GAS_TICK}|${amount}`,
                   txHash: 'b'.repeat(56) + String(n++).padStart(8, '0') });

    await seeder.seedBlock(blockIndex, blockTime, txs);
}

module.exports = { seedGas, GAS_TICK, GAS_FUNDER };
