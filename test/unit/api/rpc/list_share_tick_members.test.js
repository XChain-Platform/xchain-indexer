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
 ********************************************************************/

'use strict';

const assert = require('assert');

const { qualifyTickMembers } = require('../../../../src/api/rpc/list_share_tick_members.js');

describe('shared list tick member qualification', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];

    it('qualifies bare members, preserves qualified members, and sorts UTF-8 bytes', async function () {
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

    it('uses one ticker lookup when the qualified name would exceed the limit', async function () {
        let lookups = [];
        const item = 'A'.repeat(196);
        const db = {
            getTickerId: async (tick) => {
                lookups.push(tick);
                return 9;
            }
        };

        assert.deepStrictEqual(await qualifyTickMembers(db, [item], 'DOGE', coins), ['DOGE:^9']);
        assert.deepStrictEqual(lookups, [item]);
    });

    it('drops duplicates after qualification', async function () {
        const db = { getTickerId: async () => { throw new Error('unexpected lookup'); } };

        assert.deepStrictEqual(
            await qualifyTickMembers(db, ['PEPE', 'DOGE:PEPE'], 'DOGE', coins),
            ['DOGE:PEPE']
        );
    });

    it('throws when an over-long ticker name has no indexed id', async function () {
        const item = 'A'.repeat(196);
        const db = { getTickerId: async () => null };

        await assert.rejects(
            qualifyTickMembers(db, [item], 'DOGE', coins),
            /index_tickers/
        );
    });

    it('refuses a non-array member value', async function () {
        const db = { getTickerId: async () => { throw new Error('unexpected lookup'); } };

        await assert.rejects(
            qualifyTickMembers(db, 'PEPE', 'DOGE', coins),
            TypeError
        );
    });
});
