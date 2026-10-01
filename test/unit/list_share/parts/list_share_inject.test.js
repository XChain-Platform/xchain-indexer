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
const { injectListShareLegs } = require('../../../../src/consensus/list_share_settle/inject.js');
const { planListShareLegs } = require('../../../../src/consensus/list_share_settle/legs.js');

const snapshotId = 'a'.repeat(64);

function fixture(answers){
    const calls = [];
    const mirrors = [];
    let answerIndex = 0;
    const ctx = {
        blockIndex: 50,
        blockTime: 60,
        actions: {
            async processTransaction(tx, gate){
                calls.push({ tx, gate });
                return answers[answerIndex++];
            },
        },
        indexerDb: {
            async createListShareMirror(mirror){
                mirrors.push(mirror);
            },
        },
    };
    return { ctx, calls, mirrors };
}

function args(overrides = {}){
    return Object.assign({
        legs: [],
        snapshotId,
        owner: 'bd',
        homeChain: 'DOGE',
        homeListIndex: 5,
    }, overrides);
}

function createLegs(){
    return planListShareLegs({
        seq: 1,
        listType: 2,
        added: ['a'],
        removed: [],
        mirrorIndex: null,
    });
}

function deltaLegs(){
    return planListShareLegs({
        seq: 2,
        listType: 2,
        added: ['c'],
        removed: ['a'],
        mirrorIndex: 41,
    });
}

describe('list share leg injection', function () {
    it('injects a version 1 create and records its mirror', async function () {
        const f = fixture([{ STATUS: 'valid', ACTION_INDEX: '41' }]);

        const result = await injectListShareLegs(f.ctx, args({ legs: createLegs() }));

        assert.deepStrictEqual(result, { actionIndexes: [41], mirrorIndex: 41 });
        assert.strictEqual(f.calls.length, 1);
        assert.strictEqual(f.calls[0].tx.vout, 0);
        assert.strictEqual(f.calls[0].tx.tx_hash, 'LIST_SHARE-' + snapshotId.slice(0, 48));
        assert.strictEqual(f.calls[0].tx.source, 'bd');
        assert.strictEqual(f.calls[0].gate, true);
        assert.deepStrictEqual(f.mirrors, [{
            action_index: 41,
            home_chain: 'DOGE',
            home_list_index: 5,
            block_index: 50,
        }]);
    });

    it('injects removal before addition and records no mirror', async function () {
        const f = fixture([
            { STATUS: 'valid', ACTION_INDEX: 70 },
            { STATUS: 'valid', ACTION_INDEX: 71 },
        ]);

        const result = await injectListShareLegs(f.ctx, args({ legs: deltaLegs() }));

        assert.deepStrictEqual(result, { actionIndexes: [70, 71], mirrorIndex: null });
        assert.deepStrictEqual(f.calls.map(({ tx }) => tx.vout), [0, 1]);
        assert.deepStrictEqual(f.mirrors, []);
    });

    for(const [label, refused] of [
        ['a refused first leg', { STATUS: 'invalid: X', ACTION_INDEX: 70 }],
        ['a null answer', null],
    ]){
        it('halts immediately for ' + label, async function () {
            const f = fixture([refused, { STATUS: 'valid', ACTION_INDEX: 71 }]);

            await assert.rejects(
                injectListShareLegs(f.ctx, args({ legs: deltaLegs() })),
                (error) => {
                    assert.strictEqual(error.name, 'ListShareHaltError');
                    assert.strictEqual(error.reason, 'LEG');
                    assert.strictEqual(error.snapshot_id, snapshotId);
                    assert.match(error.message, /ordinal 0/);
                    return true;
                }
            );
            assert.strictEqual(f.calls.length, 1);
            assert.deepStrictEqual(f.mirrors, []);
        });
    }

    for(const [label, override] of [
        ['an upper-case snapshot id', { snapshotId: snapshotId.toUpperCase() }],
        ['an empty owner', { owner: '' }],
        ['non-array legs', { legs: null }],
    ]){
        it('rejects ' + label + ' before injection', async function () {
            const f = fixture([]);

            await assert.rejects(
                injectListShareLegs(f.ctx, args(Object.assign({ legs: deltaLegs() }, override))),
                TypeError
            );
            assert.deepStrictEqual(f.calls, []);
            assert.deepStrictEqual(f.mirrors, []);
        });
    }

    it('returns empty indexes without injecting an empty plan', async function () {
        const f = fixture([]);

        const result = await injectListShareLegs(f.ctx, args());

        assert.deepStrictEqual(result, { actionIndexes: [], mirrorIndex: null });
        assert.deepStrictEqual(f.calls, []);
        assert.deepStrictEqual(f.mirrors, []);
    });
});
