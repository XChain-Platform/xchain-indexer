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
 * Independent, regex-free reference oracle for the PRICE v1 canonical
 * VALUE and FEE predicates, used only to cross-check the regex-based
 * production checks against a second implementation built a different
 * way. Unwired: nothing under src/ requires this file.
 *
 ********************************************************************/

'use strict';

function isDigitChar(ch) {
    return ch >= '0' && ch <= '9';
}

// One pass over `text`: '0' alone, or a nonzero digit then digits, then an
// optional '.' plus 1..maxFractionDigits digits. Anything else is false.
function isCanonicalV1Text(text, maxLength, maxFractionDigits) {
    if (typeof text !== 'string') return false;
    const len = text.length;
    if (len < 1 || len > maxLength) return false;

    let i = 0;
    if (text[0] === '0') {
        i = 1;
    } else if (isDigitChar(text[0]) && text[0] !== '0') {
        i = 1;
        while (i < len && isDigitChar(text[i])) i++;
    } else {
        return false;
    }

    if (i === len) return true;
    if (text[i] !== '.') return false;
    i++;

    const fractionStart = i;
    while (i < len && isDigitChar(text[i])) i++;
    if (i !== len) return false;

    const fractionLength = i - fractionStart;
    return fractionLength >= 1 && fractionLength <= maxFractionDigits;
}

function isCanonicalV1ValueText(text, maxLength) {
    return isCanonicalV1Text(text, maxLength, 8);
}

function isCanonicalV1FeeText(text, maxLength) {
    return isCanonicalV1Text(text, maxLength, 18);
}

module.exports = { isCanonicalV1ValueText, isCanonicalV1FeeText };
