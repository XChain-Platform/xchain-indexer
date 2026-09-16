'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The addresses and per-test context the LIST suite shares (list.test.js plus
// the files in list.test/). makeListContext builds a fresh mock indexer, actions
// context and handler and resets the util lists; each block calls it from its
// own beforeEach.

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../../fixtures/mocks');

const List = require('../../../../../../src/actions/list.js');

const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ADDR1   = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const ADDR2   = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

// A fresh mock indexer, actions context and LIST handler for one test.
function makeListContext() {
    const indexer = createMockIndexer();
    const actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction:   sinon.stub().resolves(),
    };
    const handler = new List(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = { SOURCE, ADDR1, ADDR2, makeListContext };
