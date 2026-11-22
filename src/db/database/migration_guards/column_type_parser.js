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

function readArguments(text, open, opensBackslashEscape){
    let depth = 1;
    let quote = null;
    for(let i = open + 1; i < text.length; i++){
        const ch = text[i];
        if(quote){
            if(opensBackslashEscape(text, i, quote)){ i++; continue; }
            if(ch === quote){
                if(text[i + 1] === quote) i++;
                else quote = null;
            }
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
        if(ch === '(') depth++;
        else if(ch === ')' && --depth === 0)
            return { args: text.slice(open + 1, i).trim(), end: i + 1 };
    }
    return null;
}

function parseColumnType(definition, opensBackslashEscape){
    const text = String(definition || '');
    const head = /^\s*(\w+)/.exec(text);
    if(!head) return null;
    let cursor = head[0].length;
    while(/\s/.test(text[cursor] || '')) cursor++;
    let args = null;
    if(text[cursor] === '('){
        const parsed = readArguments(text, cursor, opensBackslashEscape);
        if(!parsed) return { name: head[1].toLowerCase(), args: null, unsigned: false, incomplete: true };
        args = parsed.args;
        cursor = parsed.end;
    }
    while(/\s/.test(text[cursor] || '')) cursor++;
    const attributes = /^(?:(?:signed|unsigned|zerofill)\b\s*)*/i.exec(text.slice(cursor))[0];
    return {
        name: head[1].toLowerCase(),
        args,
        unsigned: /\b(?:unsigned|zerofill)\b/i.test(attributes),
        incomplete: false,
    };
}

module.exports = { parseColumnType };
