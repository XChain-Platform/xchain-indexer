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
const probe = require('../../../../src/actions/batch/probe.js');

const NOTE =
    'payment-triggered DISPENSE is not judged on the public pre-flight (the pre-flight transaction pays no dispenser address)';

function record(action, status, destination){
    let data = { PROBE_SUB_VERDICTS: [], STATUS: status, COIN_DESTINATION: destination };
    let ctx = {
        util: {
            isGuardInertError: value => typeof value === 'string' && value.startsWith('guard:'),
            describeGuardInert: value => 'controller skipped: ' + value
        }
    };
    probe.recordSubVerdict.call(ctx, data, action, 0, null);
    return data.PROBE_SUB_VERDICTS[0];
}

describe('BATCH DISPENSE pre-flight disclosure @regression @tier1', function () {
    it('explains a null DISPENSE verdict when the synthetic transaction has no destination', function () {
        assert.deepStrictEqual(record('DISPENSE', undefined, null), {
            position: 0, action: 'DISPENSE', status: null, refused: NOTE
        });
    });

    it('does not replace a real DISPENSE verdict or guess at a different null cause', function () {
        assert.deepStrictEqual(record('DISPENSE', 'invalid: FORMAT', null), {
            position: 0, action: 'DISPENSE', status: 'invalid: FORMAT', refused: null
        });
        assert.deepStrictEqual(record('DISPENSE', undefined, 'paidAddress'), {
            position: 0, action: 'DISPENSE', status: null, refused: null
        });
    });

    it('does not widen the note and preserves guard-inert disclosure', function () {
        assert.deepStrictEqual(record('SEND', undefined, null), {
            position: 0, action: 'SEND', status: null, refused: null
        });
        assert.deepStrictEqual(record('SEND', 'guard:token', null), {
            position: 0, action: 'SEND', status: null,
            refused: 'controller skipped: guard:token'
        });
    });
});
