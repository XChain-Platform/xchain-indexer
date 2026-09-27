/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The four PRICE v1 registry rows CBF-2 will register, as a pure test
 * helper: an independent oracle CBF-2's own test pins its rows against,
 * built before the parent row exists. Nothing here reads or writes the
 * live registry.
 *
 ********************************************************************/

'use strict';

const { UNARMED } = require('../../../../src/protocol_changes/core.js');

// The FEE pattern is VALUE's canonical matcher with the fraction widened from
// {1,8} to {1,18} (Design section 1): same integer-part rule, 18 decimals.
const PRICE_V1_FEE_RE_CANONICAL = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;

function checkCap(name, value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('expectedPriceV1Rows: caps.' + name + ' must be a positive safe integer, got ' + JSON.stringify(value));
    }
}

/**
 * The four PRICE v1 rows CBF-2 registers, in registration order.
 * @param {{value: number, fee: number}} caps  CBF-2-p1's priceV1Caps() output
 * @returns {object} a fresh { key: { kind, value } } map, never shared
 */
function expectedPriceV1Rows(caps) {
    checkCap('value', caps.value);
    checkCap('fee', caps.fee);
    return {
        'price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION': {
            kind: 'time',
            value: { mainnet: UNARMED, testnet: UNARMED, regtest: 0 },
        },
        'price_scale_activation.PRICE_V1_FEE_RE_CANONICAL': {
            kind: 'constant',
            value: PRICE_V1_FEE_RE_CANONICAL,
        },
        'price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH': {
            kind: 'constant',
            value: caps.value,
        },
        'price_scale_activation.PRICE_V1_FEE_MAX_LENGTH': {
            kind: 'constant',
            value: caps.fee,
        },
    };
}

module.exports = { expectedPriceV1Rows };
