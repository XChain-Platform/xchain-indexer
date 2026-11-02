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

// MariaDB utf8mb3 cannot represent Unicode supplementary-plane code points.
// Reject them before equality lookups so the connection's utf8mb4 parameter does
// not turn an impossible match into errno 1267 (Illegal mix of collations).
function fitsUtf8mb3(value){
    for(let character of String(value)){
        if(character.codePointAt(0) > 0xFFFF)
            return false;
    }
    return true;
}

// For a value that must still be stored, map every code point utf8mb3 cannot hold to
// U+FFFD, one for one: supplementary-plane characters, and lone surrogates (which the
// driver's UTF-8 encoder already binds as U+FFFD, so the in-memory string now equals the
// stored one). A value that already fits is returned unchanged.
function toUtf8mb3(value){
    let s = String(value);
    if(fitsUtf8mb3(s) && s.isWellFormed()) return s;
    return s.toWellFormed().replace(/[\u{10000}-\u{10FFFF}]/gu, '�');
}

module.exports = { fitsUtf8mb3, toUtf8mb3 };
