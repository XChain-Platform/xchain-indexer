'use strict';

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

const { screenListMeta } = require('../../../../src/consensus/list_share_settle/screen.js');
const { LIST_SHARE_HALT_REASON } = require('../../../../src/consensus/list_share_settle/halt.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR || path.join(
    __dirname, '..', '..', '..', '..', '..', 'xchain-documentation'
);
const vectors = require(path.join(DOCS_DIR, 'protocol/test-vectors/list_share.json'));

function assertHalt(row, metaActive, detail){
    assert.deepStrictEqual(screenListMeta(row, metaActive), {
        halt: LIST_SHARE_HALT_REASON.META_HASH,
        detail,
    });
}

describe('list share metadata screen', function () {
    it('accepts only absent or null metadata below the gate', function () {
        assert.deepStrictEqual(screenListMeta({}, false), {
            fields: { name: null, description: null, meta_hash: null },
        });
        assert.deepStrictEqual(screenListMeta({
            name: null,
            description: null,
            meta_hash: null,
        }, false), {
            fields: { name: null, description: null, meta_hash: null },
        });

        for(const field of ['name', 'description', 'meta_hash'])
            assertHalt({ [field]: '' }, false, 'meta_below_gate');
    });

    it('accepts the documentation metadata vectors at the gate', function () {
        for(const vector of vectors.metaHashes){
            assert.deepStrictEqual(screenListMeta({
                name: vector.name,
                description: vector.description,
                meta_hash: vector.expected,
            }, true), {
                fields: {
                    name: vector.name,
                    description: vector.description,
                    meta_hash: vector.expected,
                },
            }, vector.label);
        }
    });

    it('accepts absent fields with the empty metadata hash', function () {
        assert.deepStrictEqual(screenListMeta({ meta_hash: '' }, true), {
            fields: { name: null, description: null, meta_hash: '' },
        });
    });

    it('halts on forged metadata and malformed hashes', function () {
        const vector = vectors.metaHashes.find(({ label }) => label === 'name only');
        assertHalt({
            name: vector.name + ' forged',
            description: vector.description,
            meta_hash: vector.expected,
        }, true, 'meta_hash');
        assertHalt({
            name: vector.name,
            description: vector.description,
            meta_hash: '0'.repeat(64),
        }, true, 'meta_hash');
        assertHalt({
            name: vector.name,
            description: vector.description,
            meta_hash: null,
        }, true, 'meta_hash');
        assertHalt({
            name: vector.name,
            description: vector.description,
            meta_hash: vector.expected.toUpperCase(),
        }, true, 'meta_hash');
    });

    it('halts on invalid names', function () {
        assertHalt({ name: 'a'.repeat(65), meta_hash: 'irrelevant' }, true, 'name');
        assertHalt({ name: '', meta_hash: '' }, true, 'name');
        assertHalt({ name: '-', meta_hash: 'irrelevant' }, true, 'name');
    });
});
