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
 **********************************************************************
 * PRICE v1 regtest refusal fixtures: one leading-zero and one over-cap
 * case per field, built from the caller's VALUE/FEE length caps so the
 * consuming suite can loop rather than hand-write each wire.
 */

'use strict';

// caps.value and caps.fee are the VALUE and FEE character-length ceilings
// the canonical grammar floors at 19 and 20 respectively.
function assertCaps(caps) {
    if (!Number.isInteger(caps.value) || caps.value < 19)
        throw new Error('buildPriceV1RefusalCases: caps.value must be an integer >= 19');
    if (!Number.isInteger(caps.fee) || caps.fee < 20)
        throw new Error('buildPriceV1RefusalCases: caps.fee must be an integer >= 20');
}

// One character over caps.value: '1', then (caps.value - 9) zeros, then an
// 8-digit fraction, for a canonical VALUE of exactly caps.value + 1 chars.
function overCapValue(caps) {
    return '1' + '0'.repeat(caps.value - 9) + '.12345678';
}

// One character over caps.fee: '1', then (caps.fee - 19) zeros, then a
// point and 18 fraction digits, for a canonical FEE of caps.fee + 1 chars.
function overCapFee(caps) {
    return '1' + '0'.repeat(caps.fee - 19) + '.' + '0'.repeat(17) + '1';
}

function buildPriceV1RefusalCases(caps) {
    assertCaps(caps);
    return [
        { name: 'leading-zero VALUE', value: '0012.5', fee: '', status: 'invalid: VALUE (format)' },
        { name: 'leading-zero FEE', value: '12.5', fee: '00.5', status: 'invalid: FEE (format)' },
        {
            name: 'VALUE one over its cap',
            value: overCapValue(caps), fee: '',
            status: 'invalid: VALUE (format)',
        },
        {
            name: 'FEE one over its cap',
            value: '12.5', fee: overCapFee(caps),
            status: 'invalid: FEE (format)',
        },
    ];
}

module.exports = { buildPriceV1RefusalCases };
