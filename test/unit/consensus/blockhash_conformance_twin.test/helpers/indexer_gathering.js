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

// test/unit/consensus/blockhash_conformance_twin.test/helpers/indexer_gathering.js
//
// The indexer side of the consensus SQL comparison. The indexer gathers the
// block-hash preimage with one db/actions.js method per query, declared in
// gathering order, and getBlockHashes composes them without SQL of its own.
// The guard reads the literals out of those methods in THIS order, so the list
// below is the gathering order made explicit: a query moved to another method,
// or a method declared out of order, changes what is compared and fails by name.
//
// A factory rather than a plain export so the helper reuses the calling suite's
// own extraction and comment-stripping functions, which keeps this file and the
// suite reading the source by one definition of "the function body".

'use strict';

const INDEXER_GATHER_STEPS = [
    /async getBlockHashCreditRows\(block_index\)\{/,
    /async getBlockHashDebitRows\(block_index\)\{/,
    /async getBlockHashEscrowRows\(block_index\)\{/,
    /async getBlockHashActionRows\(block_index\)\{/,
    /async getBlockHashContractRows\(block_index\)\{/,
    /async getBlockHashContractStateRows\(block_index\)\{/,
    /async getBlockHashExecutionRows\(block_index\)\{/,
    /async getBlockHashEmissionRows\(block_index\)\{/,
    /async getBlockHashDepositRows\(block_index\)\{/,
    /async getBlockHashWithdrawalRows\(block_index\)\{/,
    /async getPreviousBlockHashes\(prev_block_index\)\{/
];

// Returns indexerGatheringSource(src): every gathering method's body, in the
// declared order, as one comment-stripped text. Also proves the shape the order
// depends on: the methods are declared in that order, each is called by name, and
// the composing getBlockHashes body holds no template literal of its own.
function make({ assert, stripComments, extractFunction, sqlLiterals }){
    return function indexerGatheringSource(src){
        const orchestrator = stripComments(extractFunction(src, /async getBlockHashes\(block_index\)\{/, 'db/actions.js'));
        assert.strictEqual(sqlLiterals(orchestrator).length, 0,
            'getBlockHashes must compose the gathering methods and carry no SQL of its own; a query ' +
            'placed there is outside the ordered comparison');
        let lastAt = -1;
        const bodies = [];
        for(const sig of INDEXER_GATHER_STEPS){
            const m = src.match(sig);
            assert.ok(m, 'gathering method not found in db/actions.js: ' + sig);
            assert.ok(m.index > lastAt, 'gathering methods must be declared in gathering order; ' + sig + ' is out of place');
            lastAt = m.index;
            const name = String(sig).match(/async ([A-Za-z]+)/)[1];
            assert.ok(new RegExp('this\\.' + name + '\\(').test(src), name + ' is declared but never called');
            bodies.push(stripComments(extractFunction(src, sig, 'db/actions.js')));
        }
        return bodies.join('\n');
    };
}

module.exports = { INDEXER_GATHER_STEPS, make };
