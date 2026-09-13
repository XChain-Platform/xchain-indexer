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
 * XChain Indexer - Database mixin: bridges
 * 
 * The queries over the bridges table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Pending XBRIDGE locks (v0/v3) and burns (v1/v4) for the federation relay
    // (getpendingbridgetransfers RPC, base spec section 12). One row per VALID,
    // not-yet-finalized source leg mined on THIS chain; the hub confirmation-gates on
    // (block_index, latest_block_index) and dedupes against its own bridge_transfers
    // table, exactly as getPendingCrossChainCallRequests leaves both to the hub side.
    // A refused action keeps its xbridges row (status carries the verdict) but is never
    // signed, so only 'valid' rows are read here.
    //
    // "Not yet finalized" is decided against this indexer's MIRRORED bridge_transfers
    // copy: a leg whose transfer the federation already signed (a mirror row with
    // src_chain = this coin and src_action_index = the leg, in any status but
    // 'retracted') has left flight and is excluded. Without the exclusion the read fed
    // every leg the chain had ever carried, so the hub's in_flight term summed the whole
    // bridge history (getbridgeinvariant read a permanent deficit on a healthy bridge)
    // and, once the chain had carried `limit` finalized legs, the ascending LIMIT never
    // reached a new lock at all: the bridge would have silently stopped on that chain.
    // A RETRACTED transfer (its source leg reorged) must NOT exclude the leg, or a lock
    // re-mined at the same action_index could never be re-signed.
    //
    // The mirror may be a SEPARATE connection (_mirrorDb, a node following a remote hub
    // database), so the exclusion cannot always be one join. Same connection: NOT EXISTS
    // inside the statement, so the LIMIT counts only rows still in flight. Separate
    // mirror: the local legs are paged by keyset and the mirror is asked which of each
    // page it already holds, until `limit` in-flight rows are collected or the local
    // rows run out. Both paths return the same rows, order and LIMIT semantics (the
    // getEffectiveUnprocessedCallResults split, for the same reason). The mirror is read
    // through doQueryStrict: doQuery collapses a query error into [], which here would
    // read as "nothing finalized" and quietly feed the whole history again.
    async getPendingBridgeTransfers(limit){
        let coin   = this.config['COIN'];
        let mirror = this.mirrorDb();
        if(mirror === this){
            return await this.doQuery(
                this._pendingBridgeTransfersSql(
                    `AND NOT EXISTS (
                    SELECT 1 FROM bridge_transfers bt
                    WHERE bt.src_chain=? AND bt.src_action_index=x.action_index AND bt.status<>'retracted')`),
                [coin, limit]);
        }
        let cap    = Number(limit);
        let out    = [];
        let cursor = -1;   // keyset: every page reads x.action_index > cursor
        while(out.length < cap){
            let page = await this.doQuery(this._pendingBridgeTransfersSql('AND x.action_index > ?'), [cursor, cap]);
            if(page.length === 0) break;
            let ids  = page.map(r => r.action_index);
            let held = await mirror.doQueryStrict(
                `SELECT src_action_index FROM bridge_transfers
                 WHERE src_chain=? AND status<>'retracted' AND src_action_index IN (${ids.map(() => '?').join(',')})`,
                [coin].concat(ids));
            // Compared as strings: the two handles may hand BIGINT columns back as number
            // or as bigint depending on their own driver options.
            let heldSet = new Set(held.map(r => String(r.src_action_index)));
            for(let row of page){
                if(heldSet.has(String(row.action_index))) continue;
                out.push(row);
                if(out.length >= cap) break;
            }
            if(page.length < cap) break;
            cursor = page[page.length - 1].action_index;
        }
        return out;
    },

    // Single bridge_transfers mirror row by transfer_id: the targeted re-verification a
    // hub follower runs before co-signing a leader's proposed row (field-for-field,
    // against its OWN view of the mirror), the getcrosschaincall precedent. Read through
    // the mirror handle: on a node whose hub copy lives in a separate database the
    // ledger connection holds no bridge_transfers rows at all.
    async getBridgeTransferById(transfer_id){
        let rows = await this.mirrorDb().doQuery(
            `SELECT
                transfer_id, snapshot_block, network, src_chain, src_action_index, src_address,
                dest_chain, dest_address, tick, decimals, amount, effective_time, finalizing_view,
                status, push_generation, btc_chain_id
             FROM
                bridge_transfers
             WHERE
                transfer_id=?
             LIMIT 1`,
            [transfer_id]);
        return (rows.length > 0) ? rows[0] : null;
    },

    // Applied XPOLICY snapshot metadata for a tick on THIS chain (getappliedpolicy RPC,
    // token-bridge-policy spec section 6, D25): the highest policy_seq this chain has
    // already MATERIALIZED, read as the join of the local idempotency record
    // (bridge_settlements, kind='policy') against the mirrored policy_snapshots row it
    // names. No row means no snapshot has applied here yet, which is not an error: a
    // bridged copy can exist before its first snapshot lands (the in-leg barrier gates on
    // it, the read does not).
    async getAppliedPolicySnapshot(tick){
        let rows = await this.doQuery(
            `SELECT ps.policy_seq, ps.origin_block, ps.policy_hash
             FROM
                bridge_settlements bs
                INNER JOIN policy_snapshots ps ON (ps.snapshot_id=bs.transfer_id)
             WHERE
                bs.kind='policy' AND ps.tick=? AND ps.network=?
             ORDER BY
                ps.policy_seq DESC, ps.id DESC
             LIMIT 1`,
            [String(tick), this.config['NETWORK']]);
        return (rows.length > 0) ? rows[0] : null;
    },

};
