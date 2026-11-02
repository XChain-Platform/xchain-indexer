/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/helpers/strict_columns.js
 *
 * A strict-session model of what a column stores, read from the shipped DDL, shared by
 * the regression suites that check a row writer's bound values against their columns.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const mathjs = require('mathjs');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '../../src/sql');

// Column definition as the shipped DDL states it.
function columnSpec(table, column){
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    const col = parsed.find(c => c.name === column);
    assert.ok(col, table + '.' + column + ' is absent from its schema definition');
    return col.definition;
}

// Strict-session conversion of a bound value. A Number binds as its JavaScript text
// (NaN and Infinity unquoted), a string as itself. Integer columns take a plain decimal
// spelling rounded half away from zero inside the type's range; VARCHAR(n) takes at most
// n characters; NULL only where the column allows it.
function columnAccepts(table, column, value){
    const spec = columnSpec(table, column);
    if(value === null || value === undefined)
        return !/\bNOT\s+NULL\b/i.test(spec);
    const raw = String(value).trim();
    const text = /\bVARCHAR\((\d+)\)/i.exec(spec);
    if(text)
        return Array.from(String(value)).length <= Number(text[1]);
    const type = /\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/i.exec(spec);
    assert.ok(type, table + '.' + column + ' is neither an integer nor a VARCHAR column');
    const bits = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, BIGINT: 64 }[type[1].toUpperCase()];
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
        return false;
    const n = mathjs.round(mathjs.bignumber(raw));
    const unsigned = /\bUNSIGNED\b/i.test(spec);
    const lo = unsigned ? mathjs.bignumber(0) : mathjs.bignumber(2).pow(bits - 1).neg();
    const hi = unsigned ? mathjs.bignumber(2).pow(bits).minus(1) : mathjs.bignumber(2).pow(bits - 1).minus(1);
    return n.isFinite() && n.gte(lo) && n.lte(hi);
}

module.exports = { columnSpec, columnAccepts };
