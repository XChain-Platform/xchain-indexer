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

// test/unit/consensus/blockhash_conformance_twin.test/03_preimage_shape.test.js
//
// Static drift-lock for the key names, key order, gatherer and bind of the ledger and
// contract preimage objects. Reciprocal of xchain-sync's case of the same name; the pins
// on this repo's own gathering methods read the file directly, so they never skip here.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const { stripComments, extractFunction, indexerFile, loadPair } = require('./helpers/twin_sources.js');
const { make } = require('./helpers/preimage_shape.js');

const shape = make({ assert, stripComments, extractFunction });

describe('consensus block-hash conformance twins (static drift-lock) @regression', function(){
    it('db.getBlockHashLedgerRows and getBlockHashContractData build the pinned preimage keys, in order, at the hashed block', function(){
        shape.assertIndexerPreimage(fs.readFileSync(indexerFile('src/db/actions.js'), 'utf8'));
    });

    it('BlockHasher builds the same preimage keys as db.getBlockHashLedgerRows and getBlockHashContractData', function(){
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db/actions.js');
        if(!pair) return;
        const indexer = shape.assertIndexerPreimage(pair.indexer);
        const sync    = shape.assertBlockHasherPreimage(pair.sync);
        assert.deepStrictEqual(sync.ledger, indexer.ledger.map(([key]) => key),
            'the ledger preimage keys drifted between BlockHasher and db.getBlockHashLedgerRows');
        assert.deepStrictEqual(sync.contracts, indexer.contracts.map(([key]) => key),
            'the contract preimage keys drifted between BlockHasher and db.getBlockHashContractData');
    });
});
