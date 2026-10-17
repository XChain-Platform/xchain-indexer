// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict';

const assert = require('assert');
const {
    BALANCE_DELTA_MODES,
    resolveBalanceDeltaMode,
} = require('../../../src/config/balance_delta_mode.js');

describe('balance delta mode configuration', function(){
    it('exports the supported modes', function(){
        assert.deepStrictEqual(BALANCE_DELTA_MODES, ['off', 'verify', 'on']);
    });

    const defaultCases = [
        ['an undefined value', undefined],
        ['a null value', null],
        ['an empty value', ''],
        ['a whitespace-only value', '   '],
    ];
    for(const [label, raw] of defaultCases){
        it(`defaults ${label} to off`, function(){
            assert.strictEqual(resolveBalanceDeltaMode(raw), 'off');
        });
    }

    for(const mode of BALANCE_DELTA_MODES){
        it(`accepts ${mode}`, function(){
            assert.strictEqual(resolveBalanceDeltaMode(mode), mode);
        });
    }

    it('normalizes surrounding whitespace and letter case', function(){
        assert.strictEqual(resolveBalanceDeltaMode(' VeRiFy '), 'verify');
        assert.strictEqual(resolveBalanceDeltaMode(' ON '), 'on');
    });

    it('rejects an unknown mode and names BALANCE_DELTA_MODE', function(){
        assert.throws(
            () => resolveBalanceDeltaMode('sometimes'),
            (error) => error instanceof Error &&
                error.message.includes('BALANCE_DELTA_MODE')
        );
    });
});
