/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Shared-list policy reference binding for home lists and foreign mirrors.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { bindPolicyRef, refNeedsPointer } = require('../../../../src/consensus/bridge_settle/policy_ref_bind.js');

function fakeDb(){
    const reads = [];
    return {
        reads,
        getListType: async (index, blockIndex) => {
            reads.push(['type', index, blockIndex]);
            if(index === 7) return 2;
            if(index === 8) return 1;
            return false;
        },
        getListShareMirror: async (chain, index) => {
            reads.push(['mirror', chain, index]);
            return chain === 'DOGE' && index === 2701 ? { action_index: '40' } : null;
        },
    };
}

describe('bindPolicyRef', () => {
    it('binds a shared home list using its own index', async () => {
        const db = fakeDb();
        const result = await bindPolicyRef(db, {
            ref: { chain: 'BTC', index: '7' }, coin: 'BTC', blockIndex: 90,
        });

        assert.deepStrictEqual(result, { index: 7 });
        assert.deepStrictEqual(db.reads, [['type', 7, 90]]);
    });

    it('leaves a ticker or missing home list pending', async () => {
        const db = fakeDb();

        assert.deepStrictEqual(await bindPolicyRef(db, {
            ref: { chain: 'BTC', index: 8 }, coin: 'BTC', blockIndex: 90,
        }), { pending: true });
        assert.deepStrictEqual(await bindPolicyRef(db, {
            ref: { chain: 'BTC', index: 9 }, coin: 'BTC', blockIndex: 90,
        }), { pending: true });
    });

    it('binds a foreign reference to its mirror without reading list type', async () => {
        const db = fakeDb();
        const result = await bindPolicyRef(db, {
            ref: { chain: 'DOGE', index: '2701' }, coin: 'BTC', blockIndex: 90,
        });

        assert.deepStrictEqual(result, { index: 40 });
        assert.deepStrictEqual(db.reads, [['mirror', 'DOGE', 2701]]);
    });

    it('leaves a foreign reference without a mirror pending', async () => {
        const db = fakeDb();

        assert.deepStrictEqual(await bindPolicyRef(db, {
            ref: { chain: 'LTC', index: 5 }, coin: 'BTC', blockIndex: 90,
        }), { pending: true });
        assert.deepStrictEqual(db.reads, [['mirror', 'LTC', 5]]);
    });

    it('throws a TypeError for malformed references', async () => {
        const db = fakeDb();
        const malformed = [
            { chain: 'ETH', index: 5 },
            { chain: 'DOGE', index: '05' },
            { chain: 'DOGE', index: 0 },
            { chain: 'DOGE', index: Number.MAX_SAFE_INTEGER + 1 },
            null,
        ];

        for(const ref of malformed){
            await assert.rejects(bindPolicyRef(db, { ref, coin: 'BTC', blockIndex: 90 }), TypeError);
        }
        assert.deepStrictEqual(db.reads, []);
    });
});

describe('refNeedsPointer', () => {
    it('does not need a pointer leg when the current pointer names the bound index', () => {
        assert.strictEqual(refNeedsPointer(40, 40), false);
        assert.strictEqual(refNeedsPointer('40', 40), false);
    });

    it('needs a pointer leg when the current pointer is different or unset', () => {
        assert.strictEqual(refNeedsPointer(41, 40), true);
        assert.strictEqual(refNeedsPointer(null, 40), true);
        assert.strictEqual(refNeedsPointer('', 40), true);
    });
});
