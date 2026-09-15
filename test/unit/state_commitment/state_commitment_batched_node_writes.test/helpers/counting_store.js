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
 * Shared fixtures for the batched SMT node-write suite: deterministic keys and
 * leaves, and the counting store that makes a write round trip measurable. Used
 * by ../../state_commitment_batched_node_writes.test.js and ../stakes_memo.test.js.
 ********************************************************************/

const M = require('../../../../../src/consensus/merkle.js');

function keyFor(i){ return M.sha256(Buffer.from('xc1174:' + i, 'utf8')); }
function leafFor(i){ return M.toHex(M.amountLeaf(String(i * 3 + 1) + '.00000000')); }

// A store that answers like MemoryNodeStore but counts how many WRITE calls the
// engine makes, so "one round trip per level" is measurable rather than argued.
class CountingStore {
    constructor(){
        this.map = new Map();
        this.putCalls = 0;         // single-row writes
        this.putManyCalls = 0;     // batch writes
        this.rowsWritten = 0;      // rows offered to the store, batched or not
        this.batchSizes = [];
    }
    async get(h){ return this.map.has(h) ? this.map.get(h) : null; }
    set(h, l, r){
        this.rowsWritten++;
        if(!this.map.has(h)) this.map.set(h, { left_hash: l, right_hash: r });
    }
    async put(h, l, r){ this.putCalls++; this.set(h, l, r); }
    async putMany(nodes){
        this.putManyCalls++;
        this.batchSizes.push(nodes.length);
        for(const n of nodes) this.set(n.hash, n.left, n.right);
    }
    get writeCalls(){ return this.putCalls + this.putManyCalls; }
}

// A store that predates putMany: bare {get, put}, like the subtree unit fakes
// and the bin/ instrumentation decorator. Doubles as the pre-fix reference the
// batched engine must match row for row.
class PerNodeStore extends CountingStore {
    constructor(){ super(); this.putMany = undefined; }
}

module.exports = { keyFor, leafFor, CountingStore, PerNodeStore };
