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
 * XChain Indexer - Database mixin: blocks
 * 
 * The queries over the blocks table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const { rethrowIfInfraFault } = require('../actions/faultGuard');

module.exports = {

    // Handle getting block index for a given component and request type
    async getBlockIndex(component, type){
        let block_index = null;
        // Bail out on any invalid request type
        var componentTypes = ['decoder', 'indexer'];
        if(!componentTypes.includes(component)){
            this.util.logError('Invalid component');
            return null;
        }
        // Bail out on any invalid request type. Only block-extent reads remain; the
        // legacy 'reorg' single-newest-row reader was removed (its newest-only, bare-height
        // shape silently dropped shallower-after-deeper reorgs). The live reorg path uses
        // getLastProcessedReorgId() + getReorgsSince() exclusively.
        var validTypes = ['first', 'last'];
        if(!validTypes.includes(type)){
            this.util.logError('Invalid type');
            return null;
        }
        let func  = (type=='first') ? 'MIN' : 'MAX';
        let query = 'SELECT ' + func + '(block_index) AS block_index FROM blocks';
        let results = await this.doQuery(query);
        if(results.length > 0 && !this.util.isNull(results[0]["block_index"]))
            block_index = Number(results[0]["block_index"]);
        return block_index;
    },

    // The block's own recorded timestamp, unmodified. This is the value to persist
    // and to show a user; it is NOT the value time-keyed consensus logic should read
    // on a chain whose miners can date blocks into the future (see getBlockTime).
    async getRawBlockTime(block_index){
        let key = Number(block_index);
        if(this._blockTimeCache.block_index === key)
            return this._blockTimeCache.block_time;
        let query   = `SELECT block_time from blocks where block_index=?`;
        let results;
        try {
            // doQueryStrict (not doQuery): getBlockTime feeds ProtocolChanges.isEnabled on
            // the consensus path, and doQuery collapses any decoder-DB fault to [] - which is
            // indistinguishable from "no such block" and returns the `false` sentinel. `false`
            // then coerces to 0 in isEnabled's `change.mainnet_time > current.block_time`
            // compare, silently marking every armed time-gated protocol change INACTIVE on this
            // node only (a unilateral contract_hash fork), while the fail-loud catch at
            // protocol_changes.js:583 - written precisely for a transient getBlockTime fault -
            // never fires because nothing was thrown. Throwing propagates to that catch so the
            // block rolls back and retries. See finding #898.
            results = await this.doQueryStrict(query, [block_index]);
        } catch(e){
            // Infrastructure faults (lock-wait timeout, connection loss - any errno other than
            // the benign missing-table/column 1146/1054) must reach the fail-loud gate. A failed
            // lookup is NEVER memoized, so the retry re-queries against a healthy DB.
            rethrowIfInfraFault(e);
            // Benign older-schema gap only: treat as an unresolvable block_time, uncached.
            return false;
        }
        let block_time = (results.length > 0) ? results[0]['block_time'] : false;
        this._blockTimeCache.block_index = key;
        this._blockTimeCache.block_time  = block_time;
        return block_time;
    },

    // A block's own hash, read from the DECODER database (blocks.block_hash_id points at
    // the index_transactions row that carries the hash string).
    //
    // Read on the DECODER instance, for block 1, this is the chain-instance identity the
    // cross-chain mirror fences on. Block 0 cannot serve: the regtest genesis hash is a
    // chainparams constant, identical across every re-genesis, while block 1 commits to
    // the instant the chain was created. A regtest venue that re-genesises its Bitcoin
    // chain keeps the same network name and the same hub, so this hash is the only thing
    // that separates the new chain's cross-chain rows from the dead chain's relics.
    //
    // Returns null rather than throwing on any fault: the identity is transport-only (it
    // enters no canonical and no block-hash preimage), so an unavailable decoder means
    // "not known yet" and the caller retries on a later block, never a stalled parse.
    async getDecoderBlockHash(block_index){
        let query = `SELECT t.hash AS hash FROM blocks b JOIN index_transactions t ON t.id = b.block_hash_id WHERE b.block_index = ? LIMIT 1`;
        let results;
        try {
            results = await this.doQueryStrict(query, [block_index]);
        } catch(e){
            return null;
        }
        if(!results || results.length === 0) return null;
        let hash = results[0]['hash'];
        return (typeof hash === 'string' && hash !== '') ? hash.toLowerCase() : null;
    },

    // The timestamps of the `span` blocks immediately below `block_index`, newest
    // first. Feeds the median-time-past calculation in getBlockTime. Returns what
    // exists rather than failing when fewer are available (a fresh chain near
    // genesis), matching Bitcoin, which medians whatever history it has.
    async getPreviousBlockTimes(block_index, span){
        let key   = Number(block_index);
        let count = parseInt(span);
        if(!Number.isFinite(key) || !Number.isFinite(count) || count <= 0) return [];
        let query = `SELECT block_time FROM blocks
                     WHERE block_index < ? AND block_time IS NOT NULL
                     ORDER BY block_index DESC LIMIT ?`;
        let results;
        try {
            // doQueryStrict for the same reason getRawBlockTime uses it: this feeds the
            // consensus clock, and collapsing a DB fault to [] would silently fall back
            // to the raw stamp on this node only, which is a unilateral divergence.
            results = await this.doQueryStrict(query, [key, count]);
        } catch(e){
            rethrowIfInfraFault(e);
            return [];
        }
        return (results || []).map((r) => r['block_time']);
    },

    // Read the STORED per-block hash triple (ledger/actions/contracts) for a block
    // from the blocks table - the values createBlock() committed, NOT a recompute.
    // Powers the getblockhashes RPC the hub's StateCheckpointEngine signs over.
    // LEFT JOINs the additive light-client roots (state_tree_roots): null before
    // the STATE_COMMITMENT flag-day, present after. Additive: the three flat hashes
    // above are unchanged whether or not the roots exist.
    async getStoredBlockHashes(block_index){
        let query = `SELECT
                b.block_index,
                b.block_time,
                t1.hash as ledger_hash,
                t2.hash as actions_hash,
                t3.hash as contract_hash,
                str.balances_root,
                str.stakes_root,
                str.state_root,
                str.block_merkle_root
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
                LEFT JOIN index_transactions t3 ON (t3.id=b.contract_hash_id)
                LEFT JOIN state_tree_roots  str ON (str.block_index=b.block_index)
            WHERE
                b.block_index=?`;
        let results = await this.doQuery(query, [block_index]);
        return results.length > 0 ? results[0] : null;
    },

    // Lookup a record in the `blocks` table and return record id
    async getBlockId(block_index){
        let id    = null;
        let query = "SELECT id FROM blocks WHERE block_index=? LIMIT 1"
        let results = await this.doQuery(query, [block_index]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    },

    // Handle creating/updating a block in the `blocks` table
    async createBlock(block_index, block_time){
        // Ignore empty hashes and return hardcoded record id
        if(block_index==null||block_index==='')
            return false;
        let block_id = await this.getBlockId(block_index);
        let hashes   = await this.getBlockHashes(block_index);
        // Create transaction hashes in the `index_transactions` table and get the hash id
        let ledger_hash_id   = await this.createTransaction(hashes.ledger.hash);
        let actions_hash_id  = await this.createTransaction(hashes.actions.hash);
        let contract_hash_id = await this.createTransaction(hashes.contracts.hash);
        // Replication-integrity state hash (additive; see getBlockHashes). Interned like the
        // other three but stored in its own blocks.state_hash_id column - NOT part of the
        // hub-signed checkpoint (getStoredBlockHashes does not read it back).
        // NOTE: this column was added after genesis with no historical backfill, so a
        // long-running node keeps state_hash_id = NULL for blocks indexed BEFORE the feature
        // shipped, while a from-genesis replay computes it for every block. A whole-table
        // `blocks` diff on state_hash_id for that pre-feature band is EXPECTED and is not a
        // rollback/consensus defect (it is outside any reorg window and the column is not
        // hub-signed). A live TP-03 blocks comparison should scope to the post-feature band.
        let state_hash_id    = await this.createTransaction(hashes.state.hash);
        // Create data
        let query = "INSERT INTO blocks (block_time, ledger_hash_id, actions_hash_id, contract_hash_id, state_hash_id, block_index) values (?, ?, ?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        ledger_hash_id=?,
                        actions_hash_id=?,
                        contract_hash_id=?,
                        state_hash_id=?
                    WHERE
                        block_index=?`;
        }
        let results = await this.doQuery(query, [block_time, ledger_hash_id, actions_hash_id, contract_hash_id, state_hash_id, block_index]);
        // Display status message
        let ledger    = String(hashes.ledger.hash).substring(0,5);
        let actions   = String(hashes.actions.hash).substring(0,5);
        let contracts = String(hashes.contracts.hash).substring(0,5);
        return [ledger, actions, contracts];
    },

    // Latest parsed block index (highest entry in blocks table), or 0 if none.
    async getLatestBlockIndex(){
        let results = await this.doQuery('SELECT MAX(block_index) AS max_block FROM blocks');
        if(!results || results.length === 0) return 0;
        let max = results[0].max_block;
        return (max === null || max === undefined) ? 0 : Number(max);
    },

    // The ROLLCALL window cut: the highest DOGE block whose raw header stamp is at
    // or before `maxBlockTime` (the BTC header stamp at E + ACCEPT_WINDOW).
    //
    // Both inputs are replicated chain data, so every honest DOGE indexer past the
    // maturity computes the SAME cut and the BTC side gets an answer it can agree
    // on without trusting the responder. Returns null when no block qualifies,
    // which the caller must read as "no cut exists yet" and defer -- never as an
    // empty present set, which would evict the whole federation.
    async getRollcallWindowCut(maxBlockTime){
        let t = parseInt(maxBlockTime);
        if(!Number.isFinite(t)) return null;
        let rows = await this.doQuery(
            'SELECT MAX(block_index) AS hcut FROM blocks WHERE block_time <= ?', [t]);
        let hcut = (rows && rows[0] && rows[0].hcut !== null && rows[0].hcut !== undefined)
                 ? parseInt(rows[0].hcut) : null;
        return Number.isFinite(hcut) ? hcut : null;
    },

    // Cross-chain data stub - returns no-data accessors until Phase 4
    async getCrossChainDataForVM(block_index){
        // Serializable snapshot (plain data) - the VM worker rebuilds the
        // getAttestation/isSettled accessors (keys are "CHAIN:action_index").
        //
        // CONSENSUS RULE: `settled` is built from the LOCAL cross_chain_settlements
        // table - legs THIS chain applied - never from the mirrored cross_chain_matches.
        // Mirror rows are deleted by reorg retraction without reorging this chain, so a
        // mirror-derived read would diverge between live nodes and a fresh resync. The
        // local table is action_index-anchored (drops with this chain's own reorgs) and
        // is rebuilt identically on replay. Settlements involving only other chains are
        // therefore NOT visible here (isSettled → false) - documented limitation.
        //
        // Only settlements from blocks strictly BEFORE the current one are exposed, so
        // every execution in a block sees the same snapshot regardless of whether it
        // runs before or after this block's settlement pass.
        let settled = {};
        let rows = await this.doQuery(
            `SELECT a_chain, a_action_index, b_chain, b_action_index
             FROM cross_chain_settlements
             WHERE block_index < ? AND a_chain IS NOT NULL`,
            [Number(block_index) || 0]);
        for(let r of rows){
            settled[String(r.a_chain) + ':' + String(r.a_action_index)] = true;
            settled[String(r.b_chain) + ':' + String(r.b_action_index)] = true;
        }
        // Cross-chain call results this chain originated, keyed by call_id -
        // backs xchain.crossChain.getCallResult(callId). Same consensus rule:
        // LOCAL table (xcalls), terminal rows only, visible from the block AFTER
        // the one that resolved them (resolved_block < current).
        let calls = {};
        let callRows = await this.doQuery(
            `SELECT call_id, result_status, result_payload FROM xcalls
             WHERE version = 0 AND request_status IN ('completed', 'expired')
               AND resolved_block IS NOT NULL AND resolved_block < ?`,
            [Number(block_index) || 0]);
        for(let r of callRows){
            calls[String(r.call_id)] = {
                status:  String(r.result_status || ''),
                payload: String(r.result_payload == null ? '' : r.result_payload)
            };
        }
        // getAttestation stays unwired (null) until the federation mirrors per-action
        // attestations; reserved by the documented API surface.
        return { attestations: {}, settled: settled, calls: calls };
    },

};
