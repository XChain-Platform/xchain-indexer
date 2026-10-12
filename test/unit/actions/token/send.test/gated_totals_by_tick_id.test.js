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

const assert = require('assert');

const { createMockIndexer } = require('../../../../fixtures/mocks');

const Send = require('../../../../../src/actions/send/index.js');
const { makeActionsCtx } = require('./helpers/send_harness.js');

describe('Send handler: gated totals by resolved tick ID @regression @tier1', function () {
    it('combines spellings per destination and drops unresolved ticks without mutation', function () {
        const handler = new Send(makeActionsCtx(createMockIndexer()));
        const ticks = {
            TEST:   { TICK_ID: 7, DECIMALS: 2 },
            'test^': { TICK_ID: 7, DECIMALS: 2 },
            OTHER:  { TICK_ID: 8, DECIMALS: 3 },
            NULL_ID: { TICK_ID: null, DECIMALS: 0 },
        };
        const sends = [
            ['TEST', '1.25', 'destination-a', null],
            ['test^', '2.50', 'destination-a', 'memo'],
            ['TEST', '3.00', 'destination-b', null],
            ['OTHER', '4.125', 'destination-a', null],
            ['UNKNOWN', '100', 'destination-c', null],
            ['NULL_ID', '100', 'destination-c', null],
        ];
        const sendsBefore = JSON.parse(JSON.stringify(sends));
        const ticksBefore = JSON.parse(JSON.stringify(ticks));

        const totals = handler.gatedTotalsByTickId(sends, ticks);

        assert.deepStrictEqual(Object.keys(totals['destination-a']).sort(), ['7', '8']);
        assert.strictEqual(totals['destination-a'][7].toString(), '3.75');
        assert.strictEqual(totals['destination-a'][8].toString(), '4.125');
        assert.strictEqual(totals['destination-b'][7].toString(), '3');
        assert.strictEqual(totals['destination-c'], undefined);
        assert.deepStrictEqual(sends, sendsBefore);
        assert.deepStrictEqual(ticks, ticksBefore);
    });

    it('returns a fresh empty object for empty or non-array sends', function () {
        const handler = new Send(makeActionsCtx(createMockIndexer()));
        const first = handler.gatedTotalsByTickId([], {});
        const second = handler.gatedTotalsByTickId(null, {});

        assert.deepStrictEqual(first, {});
        assert.deepStrictEqual(second, {});
        assert.notStrictEqual(first, second);
    });
});
