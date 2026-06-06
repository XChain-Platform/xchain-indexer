/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * fast-check arbitraries for token tick names.
 *
 * Generates strings conforming to (or violating) the indexer's
 * TICK_CHARACTERS set and length constraints.
 */

const fc = require('fast-check');

const TICK_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>.?';
const TICK_CHARS_ARRAY = TICK_CHARACTERS.split('');
const RESERVED_TICKS = ['BTC', 'LTC', 'DOGE', 'XCHAIN'];

/**
 * Generate a valid tick: 1–250 chars from TICK_CHARACTERS, no leading/trailing periods.
 */
function validTick() {
    return fc.array(fc.constantFrom(...TICK_CHARS_ARRAY), { minLength: 1, maxLength: 250 })
        .map(chars => chars.join(''))
        .filter(s => !s.startsWith('.') && !s.endsWith('.'));
}

/**
 * One of the reserved tick names.
 */
function reservedTick() {
    return fc.constantFrom(...RESERVED_TICKS);
}

/**
 * Generate tick names that should be rejected.
 */
function invalidTick() {
    return fc.oneof(
        // Empty string
        fc.constant(''),
        // Too long (251+ chars)
        fc.array(fc.constantFrom(...TICK_CHARS_ARRAY), { minLength: 251, maxLength: 300 })
            .map(chars => chars.join('')),
        // Characters outside TICK_CHARACTERS (use unicode chars not in the valid set)
        fc.constantFrom(
            '\u00e9token', '\u00f1NAME', 'tok\u2603en', 'MY\u00a0TICK',
            'tick`name', 'tick;name', 'tick"name', "tick'name", 'tick\\name',
            'tick\ttab', 'tick\nnewline', '\u0000null',
        ),
        // Leading/trailing periods
        fc.constantFrom('.TICK', 'TICK.', '..TEST..', '.'),
        // Whitespace
        fc.constantFrom(' TICK', 'TICK ', 'MY TICK', '\tTICK', 'TICK\n'),
        // Unicode
        fc.constantFrom('\u{1F4A9}TOKEN', 'tok\u0000en', '\u200BTICK'),
    );
}

/**
 * Union of valid, reserved, and invalid ticks.
 */
function anyTick() {
    return fc.oneof(validTick(), reservedTick(), invalidTick());
}

module.exports = {
    TICK_CHARACTERS,
    TICK_CHARS_ARRAY,
    RESERVED_TICKS,
    validTick,
    reservedTick,
    invalidTick,
    anyTick,
};
