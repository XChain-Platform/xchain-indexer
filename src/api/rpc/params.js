/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Canonical JSON-RPC scalar parsing for row indexes and page bounds.
 */

'use strict';

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const CANONICAL_UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function integer(value, { name, min = 0 } = {}) {
    let parsed = value;
    // Accept only canonical digit strings so JSON coercions cannot turn another type into an index.
    if (typeof value === 'string') {
        if (!CANONICAL_UNSIGNED_INTEGER.test(value))
            return { error: name + ' must be a ' + (min > 0 ? 'positive' : 'non-negative') + ' integer' };
        parsed = Number(value);
    }
    // Keep indexes inside JavaScript's exact integer range and above the field's floor.
    if (!Number.isSafeInteger(parsed) || parsed < min)
        return { error: name + ' must be a ' + (min > 0 ? 'positive' : 'non-negative') + ' integer' };
    return { value: parsed };
}

function optionalInteger(value, options) {
    // Preserve an omitted optional field instead of converting it to zero.
    if (value === undefined || value === null)
        return { value };
    return integer(value, options);
}

function limit(value, { defaultValue, max, name = 'limit' } = {}) {
    // Apply the route default only when the caller omitted the page size.
    if (value === undefined || value === null)
        return { value: defaultValue };
    const parsed = integer(value, { name, min: 1 });
    if (parsed.error) return parsed;
    return { value: Math.min(parsed.value, max) };
}

function string(value, { name, maxLength, required = false } = {}) {
    // Preserve an omitted optional filter and report an omitted required field.
    if (value === undefined || value === null) {
        if (required) return { error: name + ' is required' };
        return { value };
    }
    // Refuse coercible values, empty required strings and fields beyond their storage boundary.
    if (typeof value !== 'string' || (required && value.length === 0) || value.length > maxLength)
        return { error: name + ' must be a string of at most ' + maxLength + ' characters' };
    return { value };
}

function decimal(value, { name, maxLength = 80 } = {}) {
    // Preserve an omitted threshold so the database can apply its configured default.
    if(value === undefined || value === null) return { value };
    // Accept only an unsigned plain decimal within the query field's bounded wire size.
    if((typeof value !== 'string' && typeof value !== 'number') ||
       !CANONICAL_UNSIGNED_DECIMAL.test(String(value)) || String(value).length > maxLength)
        return { error: name + ' must be a non-negative decimal' };
    return { value };
}

module.exports = { integer, optionalInteger, limit, string, decimal };
