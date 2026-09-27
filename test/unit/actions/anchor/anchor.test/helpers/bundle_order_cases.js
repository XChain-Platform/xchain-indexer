// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { PUBKEY_A, PUBKEY_B, SIG } = require('./anchor_fixtures.js');

const ORDER_REFUSAL_CASES = Object.freeze([
    {
        name: 'sections DOGE then BTC',
        sections: [{ chain: 'DOGE' }, { chain: 'BTC' }],
        status: 'invalid: SECTION 1 CHAIN (order)'
    },
    {
        name: 'sections BTC, LTC, DOGE',
        sections: [{ chain: 'BTC' }, { chain: 'LTC' }, { chain: 'DOGE' }],
        status: 'invalid: SECTION 2 CHAIN (order)'
    },
    {
        name: 'pairs B then A',
        sections: [{ chain: 'BTC', sigs: [[PUBKEY_B, SIG], [PUBKEY_A, SIG]] }],
        status: 'invalid: SECTION 0 SIGS (order)'
    },
    {
        name: 'second section pairs B then A',
        sections: [
            { chain: 'BTC' },
            { chain: 'DOGE', sigs: [[PUBKEY_B, SIG], [PUBKEY_A, SIG]] }
        ],
        status: 'invalid: SECTION 1 SIGS (order)'
    }
]);

module.exports = { ORDER_REFUSAL_CASES };
