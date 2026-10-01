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
const sinon = require('sinon');

const { buildListShareRpc } = require('../../../../src/api/rpc/list_share.js');
const { qualifyTickMembers } = require('../../../../src/api/rpc/list_share_tick_members.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function sha256(value){
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function dogeRpc(view){
    return buildListShareRpc({ indexer: fakeIndexer({
        view,
        config: { COIN: 'DOGE', COINS: ['BTC', 'LTC', 'DOGE'] }
    }) });
}

describe('shared list tick member qualification', function(){
    const coins = ['BTC', 'LTC', 'DOGE'];

    afterEach(function(){ sinon.restore(); });

    it('qualifies bare members, preserves qualified members, and sorts UTF-8 bytes', async function(){
        let lookups = 0;
        const db = { getTickerId: async () => { lookups++; return 5; } };
        const members = ['PEPE', 'BTC:^5'];

        assert.deepStrictEqual(await qualifyTickMembers(db, members, 'DOGE', coins), [
            'BTC:^5',
            'DOGE:PEPE'
        ]);
        assert.strictEqual(lookups, 0);
        assert.deepStrictEqual(members, ['PEPE', 'BTC:^5']);
    });

    it('uses one ticker lookup when the qualified name would exceed the limit', async function(){
        let lookups = [];
        const item = 'A'.repeat(196);
        const db = {
            getTickerId: async tick => {
                lookups.push(tick);
                return 9;
            }
        };

        assert.deepStrictEqual(await qualifyTickMembers(db, [item], 'DOGE', coins), ['DOGE:^9']);
        assert.deepStrictEqual(lookups, [item]);
    });

    it('drops duplicates after qualification', async function(){
        const db = { getTickerId: async () => { throw new Error('unexpected lookup'); } };

        assert.deepStrictEqual(
            await qualifyTickMembers(db, ['PEPE', 'DOGE:PEPE'], 'DOGE', coins),
            ['DOGE:PEPE']
        );
    });

    it('throws when an over-long ticker name has no indexed id', async function(){
        const item = 'A'.repeat(196);
        const db = { getTickerId: async () => null };

        await assert.rejects(
            qualifyTickMembers(db, [item], 'DOGE', coins),
            /index_tickers/
        );
    });

    it('refuses a non-array member value', async function(){
        const db = { getTickerId: async () => { throw new Error('unexpected lookup'); } };

        await assert.rejects(
            qualifyTickMembers(db, 'PEPE', 'DOGE', coins),
            TypeError
        );
    });

    it('qualifies, deduplicates, and byte-sorts getlistat members before hashing', async function(){
        const view = recordingView({
            getListType: 1,
            getListAtBlock: ['PEPE', 'BTC:^5', 'PEPE'],
            getTickerId: sinon.stub().rejects(new Error('short names must not use ids'))
        });

        assert.deepStrictEqual(await dogeRpc(view).getlistat({ list_index: 7, block: 90 }), {
            type: 1,
            members: ['BTC:^5', 'DOGE:PEPE'],
            hash: sha256('MEMBERS|2|BTC:^5|DOGE:PEPE')
        });
        assert.deepStrictEqual(view.calls, [
            ['getListType', 7, 90],
            ['getListAtBlock', 7, 90]
        ]);
    });

    it('uses a ticker id in getlistat when the qualified name exceeds 200 characters', async function(){
        const longName = 'P'.repeat(196);
        const view = recordingView({
            getListType: 1,
            getListAtBlock: [longName],
            getTickerId: item => item === longName ? 41 : null
        });

        assert.deepStrictEqual(await dogeRpc(view).getlistat({ list_index: 8, block: 91 }), {
            type: 1,
            members: ['DOGE:^41'],
            hash: sha256('MEMBERS|1|DOGE:^41')
        });
        assert.deepStrictEqual(view.calls[2], ['getTickerId', longName]);
    });

    it('leaves address-list membership and order unchanged', async function(){
        const addresses = ['z-address', 'A-address', 'z-address'];
        const view = recordingView({
            getListType: 2,
            getListAtBlock: addresses,
            getTickerId: sinon.stub().rejects(new Error('address lists must not qualify'))
        });

        assert.deepStrictEqual(await dogeRpc(view).getlistat({ list_index: 9, block: 92 }), {
            type: 2,
            members: addresses,
            hash: sha256('MEMBERS|3|z-address|A-address|z-address')
        });
        assert.deepStrictEqual(view.calls, [
            ['getListType', 9, 92],
            ['getListAtBlock', 9, 92]
        ]);
    });
});
