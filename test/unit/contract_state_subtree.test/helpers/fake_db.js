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
 * test/unit/contract_state_subtree.test/helpers/fake_db.js
 *
 * The in-memory db and arming helper every contract_state_subtree PART block
 * builds on. Each part carried its own byte-identical copy, which charged the
 * structure count four extra over-limit run() methods for one piece of code.
 *
 * The ENTRY file (test/unit/contract_state_subtree.test.js) deliberately keeps
 * its own copy instead of requiring this one: the entry is byte-locked to
 * xchain-sync/test/unit/contract_state_subtree.test.js, and when this copy was
 * split out sync spelled its parts directory in camelCase, so a require naming
 * this directory would have differed across the pair and broken that lock. Both
 * repos now use the same directory name, so the entry could require this helper.
 *
 * STUB HONESTY, restated from the entry because it bounds what every vector
 * built on this proves: FakeDb implements the SEMANTICS of the three
 * contract_state queries (latest row by id, MAX(id) per key, distinct keys per
 * block) over an in-memory row array. It cannot catch a collation mistake,
 * because JS string comparison is already byte-exact where MariaDB's
 * utf8_general_ci is not.
 */
'use strict';

const SC  = require('../../../../src/state_commitment/index.js');
const SUB = require('../../../../src/consensus/gates/state_subtree_gate.js');
const CST = require('../../../../src/consensus/contract_state_subtree.js');

const CHAIN = 'BTC', NETWORK = 'regtest';

// ---- Fake db ---------------------------------------------------------------
// Rows are appended exactly as the indexer appends them: id ascending, one row
// per write, state_value = null for a VM delete. state_key_bin is modelled as
// the identical string (see STUB HONESTY above).
class FakeDb {
    constructor(){
        this.rows   = [];          // contract_state
        this.roots  = new Map();   // block_index -> { contract_state_root }
        this.nodes  = new Map();   // state_tree_nodes
        this.nextId = 1;
        this.stateQueries = 0;     // every contract_state read, for the inertness count
        // Which reader each SQL string arrived through. The derivation must
        // use doQueryStrict for ALL of its reads, because doQuery collapses a
        // non-transactional error into [] and every [] here is a meaningful (and
        // wrong) answer rather than an error signal.
        this.softSql   = [];
        this.strictSql = [];
        this.failOn    = null;     // substring: reads matching it throw, for fault injection
    }
    write(blockIndex, contractIndex, stateKey, stateValue){
        this.rows.push({ id: this.nextId++, contract_index: contractIndex,
                         state_key: stateKey, state_value: stateValue, block_index: blockIndex });
    }
    // Reorg: contract_state and state_tree_roots are both rollback:'block'.
    rollbackTo(height){
        this.rows = this.rows.filter(r => r.block_index < height);
        for(const k of Array.from(this.roots.keys())) if(k >= height) this.roots.delete(k);
    }
    storeRoot(blockIndex, contractStateRoot){
        const row = this.roots.get(blockIndex) || {};
        row.contract_state_root = contractStateRoot;
        this.roots.set(blockIndex, row);
    }
    // The shadow column: a separate value on the same row, deliberately not the
    // committed one (the explorer reassembles proofs from that).
    storeShadow(blockIndex, shadowRoot){
        const row = this.roots.get(blockIndex) || {};
        row.contract_state_root_shadow = shadowRoot;
        this.roots.set(blockIndex, row);
    }
    // One node store per NODE, shared by every block, exactly as DbNodeStore over
    // state_tree_nodes is. Handing each block a fresh store instead makes the
    // incremental thread silently start from a blank tree, because _descend reads
    // a missing row as an empty subtree: the root still looks like a hash, and
    // only the full-build comparison catches it.
    smt(){
        const self = this;
        return new SC.PersistentSMT({
            async get(h){ return self.nodes.has(h) ? self.nodes.get(h) : null; },
            async put(h, l, r){ if(!self.nodes.has(h)) self.nodes.set(h, { left_hash: l, right_hash: r }); }
        });
    }
    // The two readers are deliberately NOT one method: the node store
    // (stateCommitment's DbNodeStore) legitimately uses doQuery, so recording
    // which one each SQL string came through is what lets a vector prove the
    // derivation's own reads went strict.
    async doQuery(sql, args){
        this.softSql.push(sql);
        return await this.run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this.run(sql, args);
    }
    async run(sql, args){
        // Fault injection: model a transient DB fault. doQueryStrict propagates
        // it; doQuery would have swallowed it into [] outside a transaction.
        if(this.failOn && sql.indexOf(this.failOn) !== -1)
            throw new Error('injected DB fault');
        if(sql.indexOf('state_tree_nodes') !== -1){
            if(sql.indexOf('INSERT') === 0 || sql.indexOf('INSERT') > -1 && sql.indexOf('SELECT') === -1){
                // Consume args in (hash, left, right) TRIPLES, not just the first
                // one: DbNodeStore.putMany batches a whole path into one multi-row
                // INSERT IGNORE. Reading only args[0..2] would store row
                // one and silently drop the rest, and a fake that drops writes does
                // not fail loudly - _descend reads a missing node as an EMPTY
                // subtree, so the next block emits a truncated root that still
                // looks like a hash. That is the exact fault this file's own
                // `smt()` comment warns about, arriving through the DB fake instead.
                for(let i = 0; i + 2 < args.length; i += 3)
                    if(!this.nodes.has(args[i]))
                        this.nodes.set(args[i], { left_hash: args[i + 1], right_hash: args[i + 2] });
                return [];
            }
            const n = this.nodes.get(args[0]);
            return n ? [n] : [];
        }
        if(sql.indexOf('FROM state_tree_roots') !== -1){
            // The derivation selects ONE column aliased to `r`, choosing committed
            // vs shadow by which name the SQL carries. Honour that here, or the
            // shadow tests would silently read the committed column.
            const row = this.roots.get(args[2]);
            if(!row) return [];
            const col = (sql.indexOf('contract_state_root_shadow') !== -1)
                ? 'contract_state_root_shadow' : 'contract_state_root';
            return [{ r: (row[col] == null) ? null : row[col] }];
        }
        if(sql.indexOf('FROM contract_state') !== -1){
            this.stateQueries++;
            // Distinct keys written by one block.
            if(sql.indexOf('SELECT DISTINCT') === 0){
                const seen = new Map();
                for(const r of this.rows)
                    if(r.block_index === args[0])
                        seen.set(r.contract_index + '' + r.state_key,
                                 { contract_index: r.contract_index, state_key: r.state_key });
                return Array.from(seen.values());
            }
            // Latest row for one key: highest id wins, tombstones included.
            if(sql.indexOf('ORDER BY id DESC LIMIT 1') !== -1){
                let best = null;
                for(const r of this.rows)
                    if(r.contract_index === args[0] && r.state_key === args[1] && (!best || r.id > best.id)) best = r;
                return best ? [{ state_value: best.state_value }] : [];
            }
            // Full live set: MAX(id) per (contract_index, state_key), tombstones
            // NOT filtered here (the caller applies the mapping).
            const max = new Map();
            for(const r of this.rows){
                const k = r.contract_index + '' + r.state_key;
                const cur = max.get(k);
                if(!cur || r.id > cur.id) max.set(k, r);
            }
            return Array.from(max.values()).map(r => ({ contract_index: r.contract_index,
                                                        state_key: r.state_key, state_value: r.state_value }));
        }
        throw new Error('FakeDb: unexpected query ' + sql.slice(0, 60));
    }
}

const EMPTY = CST.EMPTY_ROOT_HEX;

// Arm contract_state_root at `height` for the duration of fn, then restore.
async function armedAt(height, fn){
    const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
    const __k0 = CHAIN + ':' + NETWORK;
    const __hadPrior = Object.prototype.hasOwnProperty.call(map, __k0), __prior = map[__k0];
    map[CHAIN + ':' + NETWORK] = height;
    try { return await fn(); } finally {
        // RESTORE, never delete: a real armed height lives in this map now, and
        // deleting the key would disarm the chain for every later test in the
        // process (which is exactly how a green suite once hid a wrong answer).
        const __k = CHAIN + ':' + NETWORK;
        if(__hadPrior) map[__k] = __prior; else delete map[__k];
    }
}

module.exports = { FakeDb, EMPTY, armedAt, CHAIN, NETWORK };
