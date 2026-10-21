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
 * XChain Indexer - Database mixin: list_share_mirrors
 *
 * The shared-list apply pass reads quorum-finalized versions from the mirror and
 * records its local mirror list and contiguous application count. Installed onto
 * Database.prototype by db/index.js, so call sites stay this.db.<method>().
 * The two MIRROR reads the apply pass consumes use doQueryStrict, so a hub-DB fault rolls
 * the block back instead of reading as no versions on this node alone.
 *
 ********************************************************************/

// The admitted pin read for each reading chain, one whole statement per chain so no column
// name is ever built at run time. A row with no admission height for the chain never matches.
const PINNED_REMOTE_TOKEN_ADMITTED_SQL = Object.freeze({
    BTC: `SELECT * FROM remote_token_snapshots
         WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ?
           AND admit_block_btc IS NOT NULL AND admit_block_btc <= ?
         ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC
         LIMIT 1`,
    LTC: `SELECT * FROM remote_token_snapshots
         WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ?
           AND admit_block_ltc IS NOT NULL AND admit_block_ltc <= ?
         ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC
         LIMIT 1`,
    DOGE: `SELECT * FROM remote_token_snapshots
         WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ?
           AND admit_block_doge IS NOT NULL AND admit_block_doge <= ?
         ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC
         LIMIT 1`
});


// MIRROR (db.mirrorDb()). The admitted form of the pin read: the newest finalized row
// whose admit_block_<chain> is at or below admission.height. Fails the block closed when
// this block skipped the remote-token barrier (see assertRemoteTokenBarrierNotSkipped).
async function getAdmittedRemoteTokenImpl(network, coin, tick, admission) {
    this.assertRemoteTokenBarrierNotSkipped('getPinnedRemoteToken');
    const chain = String(admission && admission.chain);
    const sql = Object.prototype.hasOwnProperty.call(PINNED_REMOTE_TOKEN_ADMITTED_SQL, chain)
        ? PINNED_REMOTE_TOKEN_ADMITTED_SQL[chain] : null;
    const height = Number(admission && admission.height);
    if(sql === null || !Number.isSafeInteger(height) || height < 0)
        this.util.throwError('getPinnedRemoteToken: unusable admission ' + JSON.stringify(admission));
    const rows = await this.doQueryStrict(sql,
        [String(network), String(coin).toUpperCase(), String(tick), height]);
    return rows.length > 0 ? rows[0] : null;
}

module.exports = {

    // MIRROR (db.mirrorDb()). Latest finalized federation snapshot for one remote token.
    // With no `admission` this is the presence read, byte for byte. With one, the read is
    // bounded to rows admitted on admission.chain at or below admission.height, and a row
    // with no admission height for that chain is never returned: the table has no signed
    // time to fall back on, so a NULL column means "not admitted here".
    async getPinnedRemoteToken(network, coin, tick, admission){
        if(admission !== undefined)
            return await getAdmittedRemoteTokenImpl.call(this, network, coin, tick, admission);
        const rows = await this.doQueryStrict(
            `SELECT * FROM remote_token_snapshots
             WHERE status = 'finalized' AND network = ? AND coin = ? AND tick = ?
             ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC
             LIMIT 1`,
            [String(network), String(coin).toUpperCase(), String(tick)]);
        return rows.length > 0 ? rows[0] : null;
    },

    // MIRROR (db.mirrorDb()). Latest finalized sequence for every foreign shared list in
    // this network. The grouped content key is quorum-agreed; the per-hub id is not read.
    async getListSnapshotHeads(network, coin){
        return await this.doQueryStrict(
            `SELECT home_chain, home_list_index, MAX(seq) AS max_seq
             FROM list_snapshots
             WHERE status = 'finalized' AND network = ? AND home_chain <> ?
             GROUP BY home_chain, home_list_index`,
            [String(network), String(coin)]);
    },

    // MIRROR (db.mirrorDb()). Finalized versions after a contiguous local prefix. The
    // unique (network, home_chain, home_list_index, seq) key makes seq a total order.
    async getListSnapshotsAfter(network, homeChain, homeIndex, afterSeq){
        return await this.doQueryStrict(
            `SELECT * FROM list_snapshots
             WHERE status = 'finalized' AND network = ? AND home_chain = ?
               AND home_list_index = ? AND seq > ?
             ORDER BY ` + 'seq ASC',
            [String(network), String(homeChain), homeIndex, afterSeq]);
    },

    // MIRROR (db.mirrorDb()). One finalized version at its quorum-agreed sequence.
    async getListSnapshotAtSeq(network, homeChain, homeIndex, seq){
        const rows = await this.doQuery(
            `SELECT * FROM list_snapshots
             WHERE status = 'finalized' AND network = ? AND home_chain = ?
               AND home_list_index = ? AND seq = ? LIMIT 1`,
            [String(network), String(homeChain), homeIndex, seq]);
        return rows.length > 0 ? rows[0] : null;
    },

    // LOCAL. Applied version counts for every shared list. Versions apply contiguously,
    // so the count is the applied sequence; idx_src_ref serves the grouping.
    async getAppliedListShareCounts(){
        return await this.doQuery(
            `SELECT src_chain, src_action_index, COUNT(*) AS applied_seq
             FROM bridge_settlements
             WHERE kind = 'list'
             GROUP BY src_chain, src_action_index`, []);
    },

    // LOCAL. Number of contiguous versions applied for one shared list.
    async countAppliedListShareVersions(homeChain, homeIndex){
        const rows = await this.doQuery(
            `SELECT COUNT(*) AS applied_seq FROM bridge_settlements
             WHERE kind = 'list' AND src_chain = ? AND src_action_index = ?`,
            [String(homeChain), homeIndex]);
        return rows.length > 0 ? Number(rows[0].applied_seq) : 0;
    },

    // LOCAL. Mapping from a home list to this chain's bridge-owned mirror list.
    async getListShareMirror(homeChain, homeIndex){
        const rows = await this.doQuery(
            `SELECT * FROM list_share_mirrors
             WHERE home_chain = ? AND home_list_index = ? LIMIT 1`,
            [String(homeChain), homeIndex]);
        return rows.length > 0 ? rows[0] : null;
    },

    // LOCAL. Mapping for a local mirror list action index.
    async getListShareMirrorByIndex(actionIndex){
        const rows = await this.doQuery(
            'SELECT * FROM list_share_mirrors WHERE action_index = ? LIMIT 1',
            [actionIndex]);
        return rows.length > 0 ? rows[0] : null;
    },

    // LOCAL. Record the injected mirror create under its rollback action and block.
    async createListShareMirror({ action_index, home_chain, home_list_index, block_index }){
        await this.doQuery(
            `INSERT INTO list_share_mirrors
             (action_index, home_chain, home_list_index, block_index)
             VALUES (?, ?, ?, ?)`,
            [action_index, home_chain, home_list_index, block_index]);
    },

};
