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
 *
 * OFF BTC THE PREAMBLE ABOVE IS REFUSED, and that is the protocol, not a
 * harness gap: XCHAIN is minted on BTC only, and a non-BTC chain gets its
 * XCHAIN row and balances solely through the bridge's XBRIDGE v2 in-leg
 * (actions/issue.js refuses every broadcast ISSUE of the gas tick off BTC,
 * including on regtest). So on LTC/DOGE the seeder does what the settle
 * pass does when a validator-signed lock lands (bridge_settle.js,
 * applyBridgeTransfer, in-leg branch): it creates the row through
 * Genesis.injectProtocolToken with the gasTokenParams set and credits each
 * address through an internal XBRIDGE v2 action. The decoder block stays
 * empty (the same contiguity rule holds) and the harness block loop applies
 * the pending seed when it reaches that block, inside the block's
 * transaction and at the settle pass's pinned position. What the fixture
 * skips is the quorum-signed transfer row and its escrow proof, which the
 * unit suites cover; the ledger effect is byte-for-byte what the pass writes.
 *
 * `system: true` asks for that shape on EVERY chain, BTC included. It is for a
 * parity suite that compares whole ledgers across chains and needs the
 * prerequisite identical by construction; on BTC that leg is synthetic (the
 * escrow chain never receives an in-leg), so nothing that pins BTC history
 * should use it.
 */

const crypto = require('crypto');

const GAS_TICK = 'XCHAIN';

// The synthetic-transaction prefix the settle pass stamps on the row it creates
// (bridge_settle.js BRIDGE_TX_PREFIX). Read from the module so the fixture can
// never drift from the pass on the one literal a parity capture normalizes by.
const { BRIDGE_TX_PREFIX, recordSettlement } = require('../../../src/bridge_settle.js');

// Pending system seeds, keyed by block index. Registered by seedGas when the
// bridge-shaped path is chosen and applied by the harness block loop
// (applySystemGas). Entries survive a rollback so a replay of the block
// re-applies the same seed; clearSystemGas runs when the decoder DB is wiped.
const pendingSystemGas = new Map();

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
 * @param {object} opts { blockIndex=99, blockTime=1699999000, addresses=[], amount='100',
 *                        funder=GAS_FUNDER }
 *                 Pass blockIndex explicitly when the scenario's blocks do
 *                 not start at 100; keep it contiguous (first block - 1).
 *                 Pass `funder` for a scenario that does NOT run on regtest: the
 *                 "any address may issue the gas tick" exemption in
 *                 actions/issue.js is regtest-only, so off regtest the preamble
 *                 must be issued by that network's own ADDRESS.GAS or the whole
 *                 bootstrap is rejected and every later action is unfunded.
 *                 `system: true` forces the bridge-shaped seed on every chain
 *                 (see the header). The chain is read from INDEXER_COIN, which
 *                 withCoin and the off-BTC scenarios set before seeding; unset
 *                 means BTC, the launcher's own default.
 */
async function seedGas(seeder, opts = {}) {
    const blockIndex = opts.blockIndex || 99;
    const blockTime  = opts.blockTime  || 1699999000;
    const addresses  = opts.addresses  || [];
    const amount     = opts.amount     || '100';
    const funder     = opts.funder     || GAS_FUNDER;
    const coin       = process.env.INDEXER_COIN || 'BTC';

    if (opts.system || coin !== 'BTC') {
        // Empty decoder block: keeps the index contiguous and the block count the
        // same as the broadcast preamble, while the ledger effect arrives through
        // applySystemGas when the harness loop processes this block.
        await seeder.seedBlock(blockIndex, blockTime, []);
        registerSystemGas(blockIndex, { addresses: addresses.slice(), amount: String(amount) });
        return;
    }

    // Explicit tx hashes in a 'b'-prefixed space: the seeder's auto-generated
    // hashes and several tests' hand-pinned hashes both live in 'aaa...NN',
    // so colliding there reuses a tx_hash_id and trips the transactions table's
    // UNIQUE key (observed via 06's determinism test).
    const txs = [{ source: funder, data: GAS_ISSUE,
                   txHash: 'b'.repeat(56) + '00000001' }];
    let n = 2;
    for (const addr of addresses)
        txs.push({ source: addr, data: `MINT|0|${GAS_TICK}|${amount}`,
                   txHash: 'b'.repeat(56) + String(n++).padStart(8, '0') });

    await seeder.seedBlock(blockIndex, blockTime, txs);
}

/**
 * Register a bridge-shaped gas seed for `blockIndex`: { addresses, amount }.
 * seedGas calls this itself; a fixture with its own decoder writer (the perf
 * data generator) calls it directly.
 */
function registerSystemGas(blockIndex, entry) {
    pendingSystemGas.set(Number(blockIndex), entry);
}

/** Forget every pending seed. Called when the decoder DB is wiped. */
function clearSystemGas() {
    pendingSystemGas.clear();
}

/** The pending seed for a block, or null. */
function pendingSystemGasAt(blockIndex) {
    return pendingSystemGas.get(Number(blockIndex)) || null;
}

/**
 * Apply the pending seed for `blockIndex`, if any, the way the settle pass
 * applies an XBRIDGE v2 in-leg. Call it inside the block's transaction at the
 * pass's pinned position (after processCrossChainSettlements). Returns the
 * number of credits applied, 0 when nothing was pending.
 *
 * One credit per address, each its own XBRIDGE v2 action with a
 * bridge_settlements record under a deterministic transfer id, so the rows a
 * rollback drops and a replay re-creates are the same rows the pass would leave.
 */
async function applySystemGas(indexer, blockIndex, blockTime) {
    const entry = pendingSystemGasAt(blockIndex);
    if (!entry) return 0;

    const db      = indexer.indexerDb;
    const util    = indexer.util;
    const genesis = indexer.genesis;
    const coin    = String(indexer.config['COIN']);
    const ctx     = { blockIndex: blockIndex, blockTime: blockTime, txHashPrefix: BRIDGE_TX_PREFIX };

    // The row, from the one parameter set the bridge and BTC genesis share.
    // Idempotent: a second seed on the same chain finds the row and moves on.
    await genesis.injectProtocolToken(genesis.gasTokenParams(), ctx);

    let applied = 0;
    for (const address of entry.addresses) {
        util.resetLists();
        const data = { ACTION: 'XBRIDGE', FORMAT: 2, BLOCK_INDEX: blockIndex, BLOCK_TIME: blockTime };
        data['ACTION_INDEX'] = await db.createActionIndex({ ACTION: 'XBRIDGE', BLOCK_INDEX: blockIndex, FORMAT: 2 });
        data['STATUS'] = 'valid';
        util.addAddressTicker(address, GAS_TICK);
        await util.processTransactionLedgerChanges(db, data, [[GAS_TICK, entry.amount, address]], [], []);
        await db.updateBalances(Object.keys(util.getAddressesList()));
        await db.updateTokens(util.getTickersList());
        // Unique within one chain's DB (block + address); the chain is not folded in
        // so a cross-chain parity capture sees the same id on every chain.
        const transferId = crypto.createHash('sha256')
            .update('GAS-SEED|' + blockIndex + '|' + address).digest('hex');
        await recordSettlement(db, data['ACTION_INDEX'], transferId, 'transfer', blockIndex,
            { src_chain: 'BTC', src_action_index: null, dest_chain: coin, dest_address: address, tick: GAS_TICK });
        await indexer.mapper.createMappings(data);
        applied++;
    }
    return applied;
}

module.exports = { seedGas, applySystemGas, registerSystemGas, clearSystemGas, pendingSystemGasAt,
                   GAS_TICK, GAS_FUNDER, BRIDGE_TX_PREFIX };
