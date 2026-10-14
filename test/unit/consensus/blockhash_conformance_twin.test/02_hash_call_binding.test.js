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
 **********************************************************************/

// test/unit/consensus/blockhash_conformance_twin.test/02_hash_call_binding.test.js
//
// Static drift-lock for item 8 of ../blockhash_conformance_twin.test.js: the values each
// side hands to its hash fold. Reciprocal of xchain-sync's case of the same name; the pins
// on this repo's own getBlockHashes read the file directly, so they never skip here.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const { stripComments, extractFunction, indexerFile, loadPair } = require('./helpers/twin_sources.js');

const SYNC_SIG = /async computeBlockHashes\(block_index, network, coin\)\{/;

// The previous-block fill both sides must write: each table chains to its OWN prior hash.
const PREV_HASH_FILLS = [
    "hashes['ledger'] = results[0].ledger;",
    "hashes['actions'] = results[0].actions;",
    "hashes['contracts'] = results[0].contracts;",
];

// Comment-stripped, whitespace-collapsed body of the function sigRe names.
function collapsedBody(src, sigRe, from){
    return stripComments(extractFunction(src, sigRe, from)).replace(/\s+/g, ' ');
}

// Count non-overlapping occurrences of text in a collapsed body.
function occurrences(body, text){
    return body.split(text).length - 1;
}

// Assert each statement appears exactly once, naming the one that does not.
function assertEachOnce(body, statements, from){
    for(const stmt of statements){
        assert.strictEqual(occurrences(body, stmt), 1,
            from + ' must contain exactly one `' + stmt + '`; the value it binds is a hash ' +
            'preimage input, so a one-sided change forks every follower\'s recomputed hash');
    }
}

// The previous-hash fill statements in source order, as written.
function prevHashFills(body){
    return body.match(/hashes\['\w+'\] = results\[0\]\.\w+;/g) || [];
}

// This repo's own hashing source, read without the sync sibling.
function ownActions(){
    return fs.readFileSync(indexerFile('src/db/actions.js'), 'utf8');
}

describe('consensus block-hash conformance twins (static drift-lock) @regression', function(){
    it('db.getBlockHashes hands the fold its rows in order and chains to block_index - 1', function(){
        const src = ownActions();
        const fn = collapsedBody(src, /async getBlockHashes\(block_index\)\{/, 'db/actions.js');
        assertEachOnce(fn, [
            'const actions = await this.getBlockHashActionRows(block_index);',
            'const contracts_data = await this.getBlockHashContractData(block_index);',
            'const hashes = await this.getPreviousBlockHashes(block_index - 1);',
            'let info = this.foldBlockHashes(block_index, ledger, actions, contracts_data, hashes);',
            'this.foldBlockHashes(',
            'this.getPreviousBlockHashes(',
        ], 'db.getBlockHashes');
        assertEachOnce(stripComments(src).replace(/\s+/g, ' '),
            ['foldBlockHashes(block_index, ledger, actions, contracts_data, hashes){'], 'db/actions.js');
    });

    it('db.getPreviousBlockHashes binds its argument and fills each table from its own hash', function(){
        const fn = collapsedBody(ownActions(), /async getPreviousBlockHashes\(prev_block_index\)\{/, 'db/actions.js');
        assertEachOnce(fn, ['await this.doQuery(query, [prev_block_index]);'], 'db.getPreviousBlockHashes');
        assert.deepStrictEqual(prevHashFills(fn), PREV_HASH_FILLS,
            'db.getPreviousBlockHashes cross-wires a previous-block hash into another table');
    });

    it('BlockHasher gathers at block_index, chains to block_index - 1 and fills the same keys', function(){
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db/actions.js');
        if(!pair) return;
        const fn = collapsedBody(pair.sync, SYNC_SIG, 'block_hasher.js');
        assertEachOnce(fn, [
            'const ledger = await getLedgerHashData.call(this, block_index);',
            'const actions = await getActionsHashData.call(this, block_index);',
            'const contracts_data = await getContractsHashData.call(this, block_index);',
            'const prev_block_index = block_index - 1;',
            'WHERE b.block_index=?`, [prev_block_index]);',
        ], 'BlockHasher.computeBlockHashes');
        assert.deepStrictEqual(prevHashFills(fn),
            prevHashFills(collapsedBody(pair.indexer, /async getPreviousBlockHashes\(prev_block_index\)\{/, 'db/actions.js')),
            'the previous-block hash fill drifted between BlockHasher and db.getPreviousBlockHashes');
    });
});
