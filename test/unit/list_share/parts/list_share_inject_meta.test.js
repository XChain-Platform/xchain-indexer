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

describe('list share meta leg injection', function () {
    it('records a format 4 mirror create and a format 5 meta action', async function () {
        const f = fixture([
            { STATUS: 'valid', ACTION_INDEX: '81' },
            { STATUS: 'valid', ACTION_INDEX: '82' },
        ]);
        const legs = [{
            fields: ['LIST', '4', '2', 'Named list', 'Description', '', 'a'],
            ordinal: 0,
        }, {
            fields: ['LIST', '5', '81', 'Renamed list', '', ''],
            ordinal: 2,
        }];

        const result = await injectListShareLegs(f.ctx, {
            legs,
            snapshotId,
            owner: 'bd',
            homeChain: 'DOGE',
            homeListIndex: 5,
        });

        assert.deepStrictEqual(result, { actionIndexes: [81, 82], mirrorIndex: 81 });
        assert.deepStrictEqual(f.calls.map(({ tx }) => [tx.data, tx.vout]), [
            ['LIST|4|2|Named list|Description||a', 0],
            ['LIST|5|81|Renamed list||', 2],
        ]);
        assert.ok(f.calls.every(({ gate }) => gate === true));
        assert.deepStrictEqual(f.mirrors, [{
            action_index: 81,
            home_chain: 'DOGE',
            home_list_index: 5,
            block_index: 50,
        }]);
    });
});
