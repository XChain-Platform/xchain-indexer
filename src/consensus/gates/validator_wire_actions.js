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
 **********************************************************************
 *
 * Validator wire actions: the pure half of the pre-launch admission test.
 *
 * Every action the hub broadcasts on its own is listed here by name and wire
 * format. isValidatorWireAction answers one question from a raw tx data string:
 * is this a name and format only a validator emits. It reads no registry and no
 * seed source and touches no state.
 *
 * Name and format are read the way the dispatcher reads them: the first field
 * is trimmed and upper-cased (transaction.js normalizeTransactionAction), the
 * second is trimmed, stripped of quotes, and must be a whole number up to 255,
 * with a missing or empty field meaning 0 (util.getFormatVersion).
 *
 ********************************************************************/

'use strict';

const {
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION
} = require('../../actions/attest/attest_batch_wire/constants');

const MAX_FORMAT = 255;

/**
 * Hub-broadcast wire formats by action name. PRICE format 1 is the user
 * oracle sharing the name, so it is not listed.
 */
const VALIDATOR_WIRE_FORMATS = Object.freeze({
    ANCHOR: Object.freeze([0, 1, 2, 3]),
    PRICE: Object.freeze([0]),
    NODEPROOF: Object.freeze([0]),
    ROLLCALL: Object.freeze([0, 1]),
    ATTEST: Object.freeze([1, 3, 4, ATTEST_BATCH_HEAD_VERSION, ATTEST_BATCH_CONTINUATION_VERSION])
});

/** Format of the second field, or null when it names no format. */
function parseFormat(field){
    if(field === undefined)
        return 0;
    const text = field.trim().replace(/"|'/g, '');
    if(text === '')
        return 0;
    if(!/^[0-9]+$/.test(text))
        return null;
    const format = parseInt(text, 10);
    return format <= MAX_FORMAT ? format : null;
}

/**
 * True when the raw tx data string is a validator wire action.
 * @param {*} data
 * @returns {boolean}
 */
function isValidatorWireAction(data){
    if(typeof data !== 'string' || data === '')
        return false;
    const parts = data.split('|');
    const name = parts[0].trim().toUpperCase();
    if(!Object.prototype.hasOwnProperty.call(VALIDATOR_WIRE_FORMATS, name))
        return false;
    const format = parseFormat(parts[1]);
    return format !== null && VALIDATOR_WIRE_FORMATS[name].includes(format);
}

module.exports = {
    VALIDATOR_WIRE_FORMATS,
    ATTEST_BATCH_HEAD_VERSION,
    ATTEST_BATCH_CONTINUATION_VERSION,
    isValidatorWireAction
};
