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
 * Armed-map fingerprint v2: the canonical value serialisation (VCS).
 *
 * v1 hashes the BYTES and NAMES of the gate carrier files, so a comment, a
 * reformat or a move changes it while the armed map it stands for does not.
 * v2 hashes the MEANING instead: a list of (key, value) rows, each value the
 * one the running process resolved at load, serialised here into one string
 * that is identical on every engine for the same value. Keys are literal
 * data (today's `<module stem>.<EXPORT>` spelling), never derived from where
 * a file lives, which is what lets the carriers move without moving v2.
 *
 * This module is a byte-identical twin in xchain-indexer and xchain-sync.
 * It requires nothing but `crypto`, so the same bytes serve both repos; the
 * per-repo row list lives in each repo's manifest.js instead.
 *
 * Refusal is deliberate. A type with no single obvious serialisation (Map,
 * Set, Date, BigInt, a class instance, a function nested in a data value, a
 * non-finite number) throws rather than being coerced, because a coercion
 * that maps two different values to one string would let two processes with
 * different armed maps publish the same fingerprint.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Versioned domain prefix, so a v2 preimage can never collide with any other
// sha256 preimage this platform builds.
const DOMAIN = 'xchain-armed-map/v2\n';

// Key grammar. The first segment admits upper case because today's module
// stems do (stateHash, attestation/providerMinStakeHistory) and the key must be
// today's spelling, the same one knownGateKeys() uses in the rules digest.
// The dot-separated tail names the export and, for table rows, the entry.
const KEY_RE = /^[A-Za-z0-9_/-]+(\.[A-Za-z0-9_]+)+$/;

class ArmedMapCanonicalError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArmedMapCanonicalError';
    }
}

function refuse(what, where) {
    throw new ArmedMapCanonicalError('refused ' + what + ' at ' + where);
}

// Plain means built by an object literal or Object.create(null). Anything
// with another prototype is a class instance whose meaning is its behaviour,
// not its enumerable fields, so it cannot be serialised by value.
function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function serialiseNumber(value, where) {
    if (!Number.isFinite(value)) refuse('non-finite number ' + String(value), where);
    // -0 and 0 are the same height and the same constant; JSON.stringify
    // already writes both as "0", and Object.is makes that explicit.
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
}

function serialiseObject(value, where) {
    // Code-unit order, which is what Array.prototype.sort does with no
    // comparator, so the order is the same on every engine.
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + serialise(value[k], where + '.' + k));
    return '{' + parts.join(',') + '}';
}

function serialise(value, where) {
    if (value === null) return 'null';
    switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number': return serialiseNumber(value, where);
    case 'string': return JSON.stringify(value);
    case 'undefined': return refuse('undefined', where);
    case 'bigint': return refuse('BigInt', where);
    case 'function': return refuse('function', where);
    case 'symbol': return refuse('symbol', where);
    default: break;
    }
    if (value instanceof RegExp) {
        // A pattern's meaning is its source and flags; JSON.stringify would
        // write every RegExp as {} and make all patterns equal.
        return 're:' + JSON.stringify(value.source) + ':' + JSON.stringify(value.flags);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((v, i) => serialise(v, where + '[' + i + ']')).join(',') + ']';
    }
    if (value instanceof Map) refuse('Map', where);
    if (value instanceof Set) refuse('Set', where);
    if (value instanceof Date) refuse('Date', where);
    if (!isPlainObject(value)) refuse('class instance', where);
    return serialiseObject(value, where);
}

/**
 * The VCS string of one value.
 * @param {*} value the resolved value of a row
 * @returns {string}
 * @throws {ArmedMapCanonicalError} on a refused type anywhere inside the value
 */
function canonicalValue(value) {
    return serialise(value, '$');
}

// Validates keys and refuses duplicates, then returns the rows sorted by key
// in code-unit order with each value already serialised.
function canonicalRows(rows) {
    if (!Array.isArray(rows)) throw new ArmedMapCanonicalError('rows must be an array of [key, value]');
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2) throw new ArmedMapCanonicalError('row must be [key, value]');
        const key = row[0];
        if (typeof key !== 'string' || !KEY_RE.test(key)) {
            throw new ArmedMapCanonicalError('key does not match the key grammar: ' + JSON.stringify(key));
        }
        if (seen.has(key)) throw new ArmedMapCanonicalError('duplicate key: ' + key);
        seen.add(key);
        let vcs;
        try {
            vcs = canonicalValue(row[1]);
        } catch (e) {
            if (e instanceof ArmedMapCanonicalError) throw new ArmedMapCanonicalError(key + ': ' + e.message);
            throw e;
        }
        out.push([key, vcs]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));
}

function sha256hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The exact bytes v2 hashes: DOMAIN, then `key=VCS(value)\n` per row in key order.
 * @param {Array<[string, *]>} rows
 * @returns {string}
 */
function preimage(rows) {
    return DOMAIN + canonicalRows(rows).map(([k, vcs]) => k + '=' + vcs + '\n').join('');
}

/**
 * The v2 fingerprint over rows, with a per-row hash so a mismatch between two
 * processes names the row that differs instead of two opaque hashes.
 * @param {Array<[string, *]>} rows
 * @returns {{hex: string, rows: Object<string, string>, count: number}}
 */
function fingerprint(rows) {
    const sorted = canonicalRows(rows);
    const perRow = {};
    let text = DOMAIN;
    for (const [k, vcs] of sorted) {
        perRow[k] = sha256hex(vcs);
        text += k + '=' + vcs + '\n';
    }
    return { hex: sha256hex(text), rows: perRow, count: sorted.length };
}

module.exports = { DOMAIN, KEY_RE, ArmedMapCanonicalError, canonicalValue, preimage, fingerprint };
