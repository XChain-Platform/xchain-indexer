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

'use strict';

const { toUtf8mb3 } = require('./utf8mb3.js');

// Clip a string to at most maxChars code points without splitting a surrogate pair. A
// UTF-16 length within the limit already fits (code units never undercount code points),
// so only a longer string is walked.
function clipCodePoints(value, maxChars){
    let s = String(value);
    if(s.length <= maxChars) return s;
    let end = 0;
    for(let count = 0; count < maxChars && end < s.length; count++){
        let c = s.charCodeAt(end);
        let pair = c >= 0xD800 && c <= 0xDBFF && end + 1 < s.length &&
                   (s.charCodeAt(end + 1) & 0xFC00) === 0xDC00;
        end += pair ? 2 : 1;
    }
    return s.substring(0, end);
}

// Whether a value holds more code points than a VARCHAR(maxChars) column takes, counted
// the way the server counts them. NULL and undefined bind NULL, so they never exceed.
function exceedsCodePoints(value, maxChars){
    if(value === null || value === undefined) return false;
    let s = String(value);
    return s.length > maxChars && Array.from(s).length > maxChars;
}

// The value a refused row can store in a VARCHAR(maxChars) column: code points a utf8mb3
// column cannot hold become U+FFFD (when mb3 is set), then the text is clipped to the
// column. A value that already fits is returned as given, so it binds exactly as before;
// only a value the strict server would refuse (a halted block) is changed.
function fitColumnText(value, maxChars, mb3){
    if(value === null || value === undefined) return value;
    let s = String(value);
    let mapped = mb3 ? toUtf8mb3(s) : s;
    if(mapped === s && !exceedsCodePoints(s, maxChars)) return value;
    return clipCodePoints(mapped, maxChars);
}

module.exports = { clipCodePoints, exceedsCodePoints, fitColumnText };
