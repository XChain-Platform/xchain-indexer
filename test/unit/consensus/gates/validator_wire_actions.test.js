/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const wire = require('../../../../src/consensus/gates/validator_wire_actions.js');
const batch = require('../../../../src/actions/attest/attest_batch_wire/constants.js');

const is = wire.isValidatorWireAction;
const join = (...p) => p.join('|');

describe('validator wire actions @regression @tier1', function(){
    it('admits only the validator wire formats', function(){
        assert.ok(Object.isFrozen(wire.VALIDATOR_WIRE_FORMATS));
        const admitted = {
            ANCHOR: [0, 1, 2, 3], PRICE: [0], NODEPROOF: [0], ROLLCALL: [0, 1],
            ATTEST: [1, 3, 4, batch.ATTEST_BATCH_HEAD_VERSION, batch.ATTEST_BATCH_CONTINUATION_VERSION]
        };
        for(const name of Object.keys(admitted))
            for(const format of admitted[name])
                assert.strictEqual(is(join(name, format, 'x')), true, name + ' ' + format);
        assert.deepStrictEqual(Object.keys(wire.VALIDATOR_WIRE_FORMATS).sort(), Object.keys(admitted).sort());

        for(const [name, format] of [['PRICE', 1], ['NODEPROOF', 1], ['ROLLCALL', 2], ['ATTEST', 0],
            ['ATTEST', 2], ['ANCHOR', 4], ['PRICE', 2], ['NODEPROOF', 9], ['ROLLCALL', 7], ['ATTEST', 7]])
            assert.strictEqual(is(join(name, format, 'x')), false, name + ' ' + format);
    });

    it('rejects user actions', function(){
        for(const name of ['STAKE', 'ISSUE', 'BATCH', 'SEND'])
            assert.strictEqual(is(join(name, 0, 'x')), false, name);
    });

    it('reads the name and format like the dispatcher', function(){
        assert.strictEqual(is(join(' price ', '0', 'x')), true);
        assert.strictEqual(is(join('ANCHOR', '"1"', 'x')), true);
        assert.strictEqual(is(join('ANCHOR', ' 2 ', 'x')), true);
        assert.strictEqual(is('PRICE'), true);
        assert.strictEqual(is(join('PRICE', '')), true);
        assert.strictEqual(is(join('PRICE', 'x')), false);
        assert.strictEqual(is(join('PRICE', '0.5')), false);
        assert.strictEqual(is(join('PRICE', '256')), false);
        assert.strictEqual(is(join('PRICE', '-1')), false);
    });

    it('rejects non-string and empty data', function(){
        for(const v of [null, undefined, '', 0, 5, {}, []])
            assert.strictEqual(is(v), false);
    });
});
