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
 * test/unit/escrow_leaf_subtree.test/helpers/fake_db.js
 *
 * The journal fake and fixture constants the escrow_leaf_subtree PART blocks
 * build on. The part carried them inline; hoisting them here lets the shadow
 * thread vectors split across parts without a second copy.
 *
 * The ENTRY file (test/unit/escrow_leaf_subtree.test.js) deliberately keeps its
 * own copy instead of requiring this one: the entry is byte-locked to
 * xchain-sync/test/unit/escrowLeafSubtree.test.js, whose parts directory is
 * spelled in camelCase, so a require naming this directory would differ across
 * the pair and break that lock.
 */
'use strict';

const SC = require('../../../../src/stateCommitment.js');

const CHAIN = 'BTC', NETWORK = 'regtest';
const ADDR  = '1LockerAaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TICK  = 'XCHAIN';

// Fake db over the journal + the two index tables it joins. Rows are appended
// exactly as the source appends them: one per key whose total CHANGED in a block.
class FakeDb {
    constructor(){
        this.rows = []; this.nodes = new Map(); this.nextId = 1; this.journalQueries = 0;
        // Which reader each SQL string arrived through, plus fault injection.
        // Every journal read must be strict, because doQuery turns a
        // non-transactional fault into [], and [] is delete-on-zero here.
        this.softSql   = [];
        this.strictSql = [];
        this.failOn    = null;
    }
    write(blockIndex, address, tick, lockedAmount){
        this.rows.push({ id: this.nextId++, address: address, tick: tick,
                         locked_amount: lockedAmount, block_index: blockIndex });
    }
    rollbackTo(height){ this.rows = this.rows.filter(r => r.block_index < height); }
    smt(){
        const self = this;
        return new SC.PersistentSMT({
            async get(h){ return self.nodes.has(h) ? self.nodes.get(h) : null; },
            async put(h, l, r){ if(!self.nodes.has(h)) self.nodes.set(h, { left_hash: l, right_hash: r }); }
        });
    }
    // Two readers, deliberately not one method: the balances path around this
    // module legitimately uses doQuery, so recording which reader each SQL
    // string came through is what proves the journal reads went strict.
    async doQuery(sql, args){
        this.softSql.push(sql);
        return await this.run(sql, args);
    }
    async doQueryStrict(sql, args){
        this.strictSql.push(sql);
        return await this.run(sql, args);
    }
    async run(sql, args){
        if(this.failOn && sql.indexOf(this.failOn) !== -1)
            throw new Error('injected DB fault');
        if(sql.indexOf('escrow_leaf_journal') === -1) throw new Error('unexpected query: ' + sql.slice(0, 60));
        this.journalQueries++;
        if(sql.indexOf('SELECT DISTINCT') === 0){
            const seen = new Map();
            for(const r of this.rows)
                if(r.block_index === args[0])
                    seen.set(r.address + '' + r.tick, { address: r.address, tick: r.tick });
            return Array.from(seen.values());
        }
        if(sql.indexOf('ORDER BY j.id DESC LIMIT 1') !== -1){
            const bounded = (args.length === 3);
            let best = null;
            for(const r of this.rows){
                if(r.address !== args[0] || r.tick !== args[1]) continue;
                if(bounded && r.block_index > args[2]) continue;
                if(!best || r.id > best.id) best = r;
            }
            return best ? [{ locked_amount: best.locked_amount }] : [];
        }
        // Live set: MAX(id) per key, tombstones NOT filtered in SQL.
        const max = new Map();
        for(const r of this.rows){
            const k = r.address + '' + r.tick;
            const cur = max.get(k);
            if(!cur || r.id > cur.id) max.set(k, r);
        }
        return Array.from(max.values()).map(r => ({ address: r.address, tick: r.tick,
                                                    locked_amount: r.locked_amount }));
    }
}

module.exports = { FakeDb, CHAIN, NETWORK, ADDR, TICK };
