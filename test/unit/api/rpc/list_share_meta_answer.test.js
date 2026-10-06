/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const {
    buildListShareRpc,
    listMetaAnswer
} = require('../../../../src/api/rpc/list_share.js');

function sha256(value){
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('list share metadata answer @regression @tier1', function(){
    it('normalizes missing metadata and null fields', function(){
        const emptyAnswer = { name: null, description: null, meta_hash: '' };

        assert.deepStrictEqual(listMetaAnswer(null), emptyAnswer);
        assert.deepStrictEqual(listMetaAnswer(undefined), emptyAnswer);
        assert.deepStrictEqual(listMetaAnswer({ name: null, description: null }), emptyAnswer);
    });

    it('hashes each present metadata shape using empty absent fields', function(){
        const cases = [
            [{ name: 'Watchlist' }, 'Watchlist', null, 'LISTMETA|Watchlist|'],
            [{ description: 'Priority assets' }, null, 'Priority assets', 'LISTMETA||Priority assets'],
            [{ name: 'Watchlist', description: 'Priority assets' },
                'Watchlist', 'Priority assets', 'LISTMETA|Watchlist|Priority assets'],
            [{ name: '観察リスト' }, '観察リスト', null, 'LISTMETA|観察リスト|']
        ];

        for(const [meta, name, description, canonical] of cases){
            assert.deepStrictEqual(listMetaAnswer(meta), {
                name,
                description,
                meta_hash: sha256(canonical)
            });
        }
    });

    it('continues to export the RPC builder', function(){
        assert.strictEqual(typeof buildListShareRpc, 'function');
    });
});
