// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fees/fee_quote_dry_run.test/helpers/indexer_db.js
//
// Builds the transaction and fee-read surface used by the dry-run context.

function makeIndexerDb({ feeAmount, prices, addressId, tickId, addressBalances, balanceThrows }, calls){
    return {
        getLatestBlockIndex: async () => 100,
        getBlockTime:        async () => 1000,
        beginTransaction:    async () => { calls.begin++; calls.order.push('begin'); },
        rollbackTransaction: async () => { calls.rollback++; calls.order.push('rollback'); },
        // Watchdog-fence surface: the dry-run reads the epoch after
        // beginTransaction and runs processTransaction under it. The stub
        // mirrors the real Database contract (fixed epoch, pass-through run).
        // BOTH fence entry points are stubbed. dryRunAction runs under
        // runInDryRunEpoch (the no-consensus-authority variant),
        // never runInTxEpoch; stubbing only the latter made every call here throw
        // `runInDryRunEpoch is not a function` inside the try, which the handler
        // reports as a dry-run error, so the whole file went red without naming the
        // missing surface. Keep runInTxEpoch too: it is the real Database's default
        // and a future caller that takes it must not silently lose its stub.
        currentTxEpoch:      () => 0,
        runInTxEpoch:        (epoch, fn) => fn(),
        runInDryRunEpoch:    (epoch, fn) => fn(),
        // Fee-balance surface. getAddressId is the READ-ONLY id lookup (null for
        // an address the ledger has never seen); createAddress is stubbed only so the test
        // can prove the balance read never reaches it.
        getAddressId:        async (addr) => { calls.order.push('getAddressId:' + addr); return addressId; },
        createAddress:       async () => { calls.createdAddresses++; return 999; },
        getTickerId:         async (tick) => { calls.order.push('getTickerId:' + tick); return tickId; },
        getAddressBalances:  async (id) => {
            calls.order.push('getAddressBalances:' + id);
            if(balanceThrows) throw new Error('balance read exploded');
            return addressBalances;
        },
        // The handler-staged fee row, readable only between begin and rollback.
        getFeeRecord:        async (ai) => {
            calls.order.push('getFeeRecord:' + ai);
            return (feeAmount == null) ? null : { amount: feeAmount, gas_cost: 0, gas_price: '0', xchain_amount: feeAmount, payment_mode: 1 };
        },
        getLatestPrice:      async (pair) => {
            if(prices[pair] == null) return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

module.exports = { makeIndexerDb };
