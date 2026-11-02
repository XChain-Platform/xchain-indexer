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

module.exports = { clipCodePoints };
