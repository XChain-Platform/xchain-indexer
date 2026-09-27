'use strict';

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
 ********************************************************************/

const BTC_SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const TOKEN_TICK_ID = 1;
const GAS_TICK_ID = 2;
const DENY_CONTROLLER_INDEX = 11;
const ALLOW_CONTROLLER_INDEX = 12;

function gasLessBtcSource() {
    return {
        [BTC_SOURCE]: {
            [TOKEN_TICK_ID]: '1000',
            [GAS_TICK_ID]: '0',
        },
    };
}

function boundGuard(_subject, contractIndex) {
    return { contract_index: contractIndex };
}

function denyBoundToken(tickId) {
    return boundGuard(tickId, DENY_CONTROLLER_INDEX);
}

function allowBoundToken(tickId) {
    return boundGuard(tickId, ALLOW_CONTROLLER_INDEX);
}

function denyBoundAddress(address) {
    return boundGuard(address, DENY_CONTROLLER_INDEX);
}

function allowBoundAddress(address) {
    return boundGuard(address, ALLOW_CONTROLLER_INDEX);
}

function unboundGuard() {
    return null;
}

module.exports = {
    gasLessBtcSource,
    denyBoundToken,
    allowBoundToken,
    denyBoundAddress,
    allowBoundAddress,
    unboundGuard,
};
