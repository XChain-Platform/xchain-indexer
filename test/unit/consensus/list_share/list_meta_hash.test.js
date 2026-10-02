// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const path = require('path');

const { listMetaHash } = require('../../../../src/consensus/list_share_hash.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR || path.join(
    __dirname, '..', '..', '..', '..', '..', 'xchain-documentation'
);
const vectors = require(path.join(DOCS_DIR, 'protocol/test-vectors/list_share.json'));

describe('listMetaHash', function(){
    it('matches the documentation metadata vectors', function(){
        for(const vector of vectors.metaHashes)
            assert.strictEqual(
                listMetaHash(vector.name, vector.description),
                vector.expected,
                vector.label
            );
    });
});
