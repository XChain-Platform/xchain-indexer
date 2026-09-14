// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The addresses, base block time and wire builders the BET suite shares
// (bet.test.js plus the files in bet.test/). Everything here is pure: the
// mock indexer each block builds stays in the block's own beforeEach.

const { createBaseData } = require('../../../../fixtures/mocks');

const ORACLE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ALICE  = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BOB    = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';
const CAROL  = 'mqPXTX9BpNzHmB3rd94xhk3SLZBjWK5B7c';

const T0 = 1700000000; // base BLOCK_TIME

// A live feed dict as getBetFeedInfo returns it
function feedInfo(overrides = {}) {
    return {
        ACTION_INDEX: 5,
        SOURCE: ORACLE,
        LABEL: 'Test market',
        OUTCOMES: 'yes,no',
        TICK: 'TEST',
        FEE: '1.00',
        DEADLINE: T0 + 86400,
        REFUND_WINDOW: 1209600,
        EXPIRE_AT: T0 + 86400 + 1209600,
        MIN_AMOUNT: null,
        ALLOW_LIST: null,
        BLOCK_LIST: null,
        FEED_STATUS: 'open',
        CLOSED_BLOCK: null,
        TERMINAL_BLOCK: null,
        ...overrides,
    };
}

function makeCreateParams(over = {}) {
    const p = {
        LABEL: 'Test market', OUTCOMES: 'yes,no', TICK: 'TEST', FEE: '1.00',
        DEADLINE: String(T0 + 86400), REFUND_WINDOW: '', MIN_AMOUNT: '',
        ALLOW_LIST: '', BLOCK_LIST: '', DETAILS: '', MEMO: '',
        ...over,
    };
    return ['0', p.LABEL, p.OUTCOMES, p.TICK, p.FEE, p.DEADLINE, p.REFUND_WINDOW,
            p.MIN_AMOUNT, p.ALLOW_LIST, p.BLOCK_LIST, p.DETAILS, p.MEMO];
}

/*****************************************************************
 * DETAILS validation
 ****************************************************************/

function b64(obj){ return Buffer.from(JSON.stringify(obj)).toString('base64'); }

/*****************************************************************
 * Format 2 - Place Bet
 ****************************************************************/

function placeData(over = {}) {
    return createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE: ALICE, ...over });
}

module.exports = { ORACLE, ALICE, BOB, CAROL, T0, feedInfo, makeCreateParams, b64, placeData };
