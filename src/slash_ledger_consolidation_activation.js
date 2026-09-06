/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Multi-slash ledger flag-day: a second slash must not erase the first.
 *
 * THE DEFECT. actions/execute.js _processSlashEmission writes each slash's
 * escrow releases and its destination credit under the enclosing EXECUTE's
 * action_index, and db.createLedgerChangeRecord keys a ledger row on
 * (action_index, address_id, tick_id) and, when the row already exists, runs
 * `UPDATE ... SET amount=?`. It OVERWRITES; it does not accumulate. So two
 * same-token slashes inside one EXECUTE debit stake and release escrow for the
 * full total while the destination credit keeps only the LAST write, and two
 * slashes against the same owner collapse that owner's escrow release the same
 * way. Balances, tokens.supply and the state commitment then disagree.
 *
 * It is not a corner case. protocol/contract-staking.md says graduated
 * penalties are implemented by "calling `slash` multiple times", which is
 * exactly the shape that loses value.
 *
 * THE RULE. When active, _processSlashEmission carries a per-execution running
 * total for each (tick, address) it writes and passes the RUNNING TOTAL to
 * createCredit / createEscrow, so the overwriting UPDATE lands the correct
 * cumulative figure. Ledger rows stay on the EXECUTE's action_index, which is
 * what the escrow journal's EXECUTE rule, slash_events.EXECUTION_INDEX and
 * contract_slash_debits.execution_index all resolve through, and per-slash
 * granularity stays where it already lives, in slash_events.
 *
 * WHY THE ACCUMULATOR IS PER EXECUTION, NOT PER INDEXER. A nested EXECUTE
 * emission runs its own execute() frame under its own action_index; merging
 * its slashes into the parent's totals would write the parent's action_index
 * figure onto the child's row. The accumulator is therefore created in the
 * frame that owns the action_index and handed down, and it is abandoned with
 * the frame when the surrounding savepoint rolls back.
 *
 * WHY A FLAG-DAY. It changes stored ledger amounts, so a from-genesis replay
 * under the new rule diverges from a chain indexed under the old one.
 *
 * `null` means NOT YET PINNED and therefore inert: the legacy per-emission
 * write runs verbatim and historical replay stays byte-identical. Mainnet and
 * testnet are unpinned pending the count of EXECUTEs already carrying more
 * than one same-token slash (group slash_events by EXECUTION_INDEX, TICK_ID
 * having count > 1), which is what decides both the pin height and whether a
 * reindex is owed; regtest runs from genesis, matching
 * stake_weight_collation_activation.js.
 *
 * Indexer-only with no xchain-sync twin: xchain-sync replicates materialized
 * ledger rows and never runs an emission handler.
 *
 ********************************************************************/

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy per-emission overwrite, byte-identical
// replay).
const SLASH_LEDGER_CONSOLIDATION_ACTIVATION = {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
};

// Per-chain threshold with a network-wide fallback, byte-for-byte the lookup
// stake_weight_collation_activation.js uses. A coin-less caller (unit fixtures)
// falls through to the bare network key and stays inert on mainnet/testnet,
// which is the safe side.
function _activationThreshold(network, coin){
    if(coin != null && SLASH_LEDGER_CONSOLIDATION_ACTIVATION[coin + ':' + network] !== undefined)
        return SLASH_LEDGER_CONSOLIDATION_ACTIVATION[coin + ':' + network];
    return SLASH_LEDGER_CONSOLIDATION_ACTIVATION[network];
}

// Whether slash ledger rows accumulate across one execution's emissions for a
// block on `network`/`coin`. An unpinned chain, an unknown network, or an
// unparseable/absent block_index -> off, i.e. the legacy per-emission write.
function isSlashLedgerConsolidationActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined || threshold === null) return false;
    return b >= threshold;
}

module.exports = {
    SLASH_LEDGER_CONSOLIDATION_ACTIVATION,
    isSlashLedgerConsolidationActive
};
