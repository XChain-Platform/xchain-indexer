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
 * XChain Indexer - Database mixin part: stakes / eviction_sweep
 *
 * The eviction sweep's stake reads and its source-scoped deactivation stamp.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Every stake row an eviction must sweep for `source`, grouped by signing key.
    //
    // INCLUDES PENDING-ACTIVATION ROWS, which is the difference from the UNSTAKE
    // path and is deliberate: UNSTAKE leaves them alone because the actor chose an
    // amount that did not cover them, but an eviction is not an amount, it is a
    // removal. Leaving them would let a 1-XCHAIN top-up landed just before the
    // epoch walk the source straight back in.
    async getSweepableStakeBySource(source, blockIndex, includePending){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        let query = `SELECT s.signing_pubkey_id                     AS signing_pubkey_id,
                            ip.pubkey                               AS signing_pubkey,
                            SUM(CAST(s.amount AS DECIMAL(30,8)))    AS amount
                       FROM stakes s
                            LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                      WHERE s.source_id = ? AND s.status_id = ? AND s.deactivation_block IS NULL`;
        let args = [source_id, valid_id];
        if(!includePending && blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ?';
            args.push(blockIndex);
        }
        // Pin the row order on the natural key: the sole caller mints one action_index per
        // returned row, so this ORDER is consensus (never signing_pubkey_id, a local surrogate).
        //
        // Collate utf8_bin because index_pubkeys.pubkey is declared utf8_general_ci, a folding
        // collation that can tie two keys the order must separate (charset held at boot).
        query += ' GROUP BY s.signing_pubkey_id, ip.pubkey ORDER BY ip.pubkey COLLATE utf8_bin ASC';
        let rows = await this.doQuery(query, args);
        // Fail closed on a dangling signing_pubkey: LEFT JOIN nulls tie under any order, and
        // the caller would mint an UNSTAKE against an index_pubkeys row createUnstake invents.
        for(const r of rows){
            if(r.signing_pubkey === null || r.signing_pubkey === undefined || String(r.signing_pubkey) === '')
                throw new Error('getSweepableStakeBySource: source ' + String(source) +
                                ' has a stake row whose signing_pubkey_id ' + String(r.signing_pubkey_id) +
                                ' has no index_pubkeys row');
        }
        return rows.map((r) => ({
            signing_pubkey_id: r.signing_pubkey_id,
            signing_pubkey:    r.signing_pubkey,
            amount:            (r.amount === null || r.amount === undefined) ? '0' : String(r.amount)
        }));
    },

    // SOURCE-SCOPED deactivation stamp, and the scoping is a correctness
    // requirement rather than tidiness. setStakeDeactivationByPubkey has no
    // source_id term, so against a key held by two sources it would deactivate the
    // OTHER source's stake as well -- an eviction of one validator silently
    // un-membering a second. `includePending` drops the activation_block ceiling so
    // the sweep covers the pending rows getSweepableStakeBySource counted.
    async setStakeDeactivationBySourceAndPubkey(source, pubkey, deactivationBlock, currentBlock, includePending){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        let args = [deactivationBlock, source_id, pubkey_id, valid_id];
        if(!includePending){
            query += ' AND activation_block <= ?';
            args.push(currentBlock);
        }
        await this.doQuery(query, args);
        return true;
    },

};
