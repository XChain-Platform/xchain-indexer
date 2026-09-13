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
 *
 * XChain Indexer - Database mixin: bridge_settlements
 *
 * The settle pass's reads and writes: this chain's own bridge_settlements ledger,
 * and the mirrored bridge_transfers / policy_snapshots rows the pass draws from.
 * Installed onto Database.prototype by db/index.js, so call sites stay
 * this.db.<method>().
 *
 * WHICH INSTANCE EACH METHOD RUNS ON is part of its contract and is named in each
 * comment. The bridge_settlements methods run on the LOCAL indexer db, because a
 * mirrored row can be retracted later and so cannot answer "did this chain already
 * apply it?". The bridge_transfers and policy_snapshots methods are called on the
 * MIRROR instance (db._mirrorDb()), which is where those rows live.
 *
 ********************************************************************/

module.exports = {

    // LOCAL. Has this chain already applied (id, kind)? `kind` is inside the unique key, so a
    // transfer id and a snapshot id may collide in the id column without colliding as
    // settlements.
    async isBridgeSettlementRecorded(id, kind){
        const rows = await this.doQuery(
            'SELECT transfer_id FROM bridge_settlements WHERE transfer_id = ? AND kind = ? LIMIT 1',
            [String(id), String(kind)]);
        return rows.length > 0;
    },

    // LOCAL. Has this chain already applied a TRANSFER settlement for this SOURCE leg, under
    // any transfer_id? Keyed on the source leg alone and never on transfer_id, which carries
    // snapshot_block and so differs between two rows naming one leg.
    async isBridgeSourceLegSettled(srcChain, srcActionIndex){
        const rows = await this.doQuery(
            `SELECT transfer_id FROM bridge_settlements
         WHERE kind = 'transfer' AND src_chain = ? AND src_action_index = ? LIMIT 1`,
            [String(srcChain), srcActionIndex]);
        return rows.length > 0;
    },

    // LOCAL. Which of these transfer ids already carry a 'transfer' settlement here.
    async getRecordedTransferSettlementIds(ids){
        return await this.doQuery(
            `SELECT transfer_id FROM bridge_settlements
         WHERE kind = 'transfer' AND transfer_id IN (${ids.map(() => '?').join(',')})`, ids);
    },

    // LOCAL. The same read for the policy leg. Two methods rather than one with a bound kind,
    // so each statement stays exactly the text it was.
    async getRecordedPolicySettlementIds(ids){
        return await this.doQuery(
            `SELECT transfer_id FROM bridge_settlements
         WHERE kind = 'policy' AND transfer_id IN (${ids.map(() => '?').join(',')})`, ids);
    },

    // LOCAL. Source legs this chain has already settled, within the candidate chains and
    // indexes. Two IN lists select the CROSS PRODUCT of chains and indexes, so the caller
    // matches the pair itself rather than trusting the query: without that, an applied leg on
    // one chain would suppress the same action index on another.
    async getSettledBridgeSourceLegs(legChains, legIndexes){
        return await this.doQuery(
            `SELECT src_chain, src_action_index FROM bridge_settlements
             WHERE kind = 'transfer' AND src_chain IN (${legChains.map(() => '?').join(',')})
               AND src_action_index IN (${legIndexes.map(() => '?').join(',')})`,
            legChains.concat(legIndexes));
    },

    // LOCAL. Record the applied leg. INSERT IGNORE on (transfer_id, kind), the
    // recordCrossChainSettlement shape: the action_index is rollback-able, so a reorg below
    // the applying block drops this row and the transfer re-applies at a fresh index.
    async recordBridgeSettlement(actionIndex, id, kind, blockIndex, srcChain, srcActionIndex,
                                 destChain, destAddress, tick){
        await this.doQuery(
            `INSERT IGNORE INTO bridge_settlements
         (action_index, transfer_id, kind, block_index, src_chain, src_action_index, dest_chain, dest_address, tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [actionIndex, String(id), String(kind), blockIndex,
             srcChain, srcActionIndex, destChain, destAddress, tick]);
    },

    // MIRROR. Finalized snapshots for this (network, origin, tick) at a LOWER policy_seq, in
    // seq order. effective_time is not monotonic across seq, so an earlier seq can come due at
    // a later block; this read is what carries a row forward until its predecessors are in.
    async getEarlierFinalizedPolicySnapshots(network, originChain, tick, seq){
        return await this.doQuery(
            `SELECT snapshot_id FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND origin_chain = ? AND tick = ? AND policy_seq < ?
         ORDER BY policy_seq ASC`,
            [String(network), originChain, tick, seq]);
    },

    // MIRROR. The finalized, effective transfers whose destination is this chain, in
    // (snapshot_block, transfer_id) order.
    //
    // `bind` is the caller's admission-era clause ({ sql, args }), spliced rather than computed
    // here because the era key is the BLOCK being processed, which only the pass's ctx knows;
    // the connection has no opinion about it. Its text comes from mirrorBindClause and is built
    // from a coin name and constants, never from row content.
    //
    // ORDERED ON QUORUM-AGREED ROW CONTENT and never on the hub-assigned AUTO_INCREMENT `id`,
    // which is per-hub: two indexers mirroring different hubs must settle the same prefix, and
    // an id-ordered query would give them different ones.
    async getFinalizedBridgeTransfersForChain(network, destChain, bind){
        return await this.doQuery(
            `SELECT * FROM bridge_transfers
         WHERE status = 'finalized' AND network = ? AND ${bind.sql} AND dest_chain = ?
         ORDER BY snapshot_block ASC, transfer_id ASC`,
            [String(network)].concat(bind.args, [String(destChain)]));
    },

    // MIRROR. Every finalized, effective policy snapshot for this network.
    //
    // No chain clause, deliberately: every chain reads every snapshot. In the admission era
    // THIS chain's column decides, and a row whose map never named this chain has that column
    // NULL and binds by the clock, which is the fail-closed direction for a chain added later.
    // The caller sorts; see duePolicySnapshots for why the total order cannot be expressed here.
    async getFinalizedPolicySnapshots(network, bind){
        return await this.doQuery(
            `SELECT * FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND ${bind.sql}`,
            [String(network)].concat(bind.args));
    },

};
