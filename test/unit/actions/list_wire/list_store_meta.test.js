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

const { storeMeta } = require('../../../../src/actions/list/store.js');

async function invoke(data, status, currentMeta = null){
    const original = { ...data };
    const creates = [];
    const reads = [];
    const context = {
        indexerDb: {
            async createListMeta(...args){
                creates.push(args);
            },
            async getListMeta(...args){
                reads.push(args);
                return currentMeta;
            },
        },
    };

    await storeMeta.call(context, data, status);
    assert.deepStrictEqual(data, original);
    return { creates, reads };
}

describe('LIST metadata storage', function(){
    it('stores a valid format 4 name against its own action', async function(){
        const data = {
            VERSION: '4', ACTION_INDEX: 41, LIST_ACTION_INDEX: null,
            NAME: 'Treasury', DESCRIPTION: '', BLOCK_INDEX: 10,
        };
        const { creates, reads } = await invoke(data, 'valid');

        assert.strictEqual(creates.length, 1);
        assert.notStrictEqual(creates[0][0], data);
        assert.deepStrictEqual(creates[0], [
            { ...data, LIST_ACTION_INDEX: 41 }, 'Treasury', null
        ]);
        assert.deepStrictEqual(reads, []);
    });

    it('stores a valid format 4 description', async function(){
        const data = {
            VERSION: '4', ACTION_INDEX: 42, NAME: '',
            DESCRIPTION: 'Watched wallets', BLOCK_INDEX: 11,
        };
        const { creates } = await invoke(data, 'valid');

        assert.deepStrictEqual(creates[0], [
            { ...data, LIST_ACTION_INDEX: 42 }, null, 'Watched wallets'
        ]);
    });

    it('stores null fields for a valid empty format 4 meta', async function(){
        const data = {
            VERSION: '4', ACTION_INDEX: 43, NAME: '', DESCRIPTION: '',
        };
        const { creates } = await invoke(data, 'valid');

        assert.deepStrictEqual(creates[0], [
            { ...data, LIST_ACTION_INDEX: 43 }, null, null
        ]);
    });

    it('does not store an invalid format 4 meta', async function(){
        const { creates, reads } = await invoke({
            VERSION: '4', ACTION_INDEX: 44, NAME: 'Bad', DESCRIPTION: '',
        }, 'invalid: NAME (format)');

        assert.deepStrictEqual(creates, []);
        assert.deepStrictEqual(reads, []);
    });

    it('stores a format 5 name and carries the current description', async function(){
        const data = {
            VERSION: '5', ACTION_INDEX: 51, LIST_ACTION_INDEX: 41,
            NAME: 'New treasury', DESCRIPTION: '', BLOCK_INDEX: 20,
        };
        const { creates, reads } = await invoke(data, 'valid', {
            name: 'Treasury', description: 'Watched wallets',
        });

        assert.deepStrictEqual(reads, [[41, 20]]);
        assert.deepStrictEqual(creates, [[
            data, 'New treasury', 'Watched wallets'
        ]]);
    });

    it('clears a format 5 field with a dash', async function(){
        const data = {
            VERSION: '5', ACTION_INDEX: 52, LIST_ACTION_INDEX: 41,
            NAME: '-', DESCRIPTION: '', BLOCK_INDEX: 21,
        };
        const { creates } = await invoke(data, 'valid', {
            name: 'Treasury', description: 'Watched wallets',
        });

        assert.deepStrictEqual(creates, [[data, null, 'Watched wallets']]);
    });

    it('stores null fields for a valid format 5 with no current meta', async function(){
        const data = {
            VERSION: '5', ACTION_INDEX: 53, LIST_ACTION_INDEX: null,
            NAME: '', DESCRIPTION: '', BLOCK_INDEX: 22,
        };
        const { creates, reads } = await invoke(data, 'valid');

        assert.deepStrictEqual(reads, [[null, 22]]);
        assert.deepStrictEqual(creates, [[data, null, null]]);
    });

    it('stores null fields for an invalid format 5 without reading', async function(){
        const data = {
            VERSION: '5', ACTION_INDEX: 54, LIST_ACTION_INDEX: 41,
            NAME: 'Bad', DESCRIPTION: 'Bad', BLOCK_INDEX: 23,
        };
        const { creates, reads } = await invoke(data, 'invalid: NAME (format)');

        assert.deepStrictEqual(reads, []);
        assert.deepStrictEqual(creates, [[data, null, null]]);
    });

    it('does not store metadata for format 0', async function(){
        const { creates, reads } = await invoke({
            VERSION: '0', ACTION_INDEX: 1, NAME: 'Ignored', DESCRIPTION: '',
        }, 'valid');

        assert.deepStrictEqual(creates, []);
        assert.deepStrictEqual(reads, []);
    });
});
