'use strict';

// Copyright 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const swq = require('../stake_weighted_quorum.js');

const HEX64 = /^[0-9a-fA-F]{64}$/;

// Return why one parsed entry cannot participate in a stake-weighted quorum.
// Stake fields are judged by the quorum module so validation stays aligned.
function entryError(entry, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return 'entry ' + index + ' is not an object';
    }
    for (const field of ['pubkey', 'weight', 'source']) {
        if (typeof entry[field] !== 'string') {
            return 'entry ' + index + ' has no string `' + field + '`';
        }
    }
    if (!HEX64.test(entry.pubkey)) {
        return 'entry ' + index + ' `pubkey` is not a 64-hex Ed25519 public key';
    }
    try {
        swq.totalStake([entry]);
    } catch (error) {
        return 'entry ' + index + ' has an unusable stake field (' + error.message + ')';
    }
    return null;
}

/**
 * Parse and validate a JSON-encoded pinned validator set.
 * @param {string} raw JSON text
 * @returns {{set: Array<{pubkey: string, weight: string, source: string}> | null, error: string | null}}
 */
function parsePinnedSet(raw) {
    let set;
    try {
        set = JSON.parse(raw);
    } catch (error) {
        return { set: null, error: 'is not valid JSON (' + error.message + ')' };
    }
    if (!Array.isArray(set)) return { set: null, error: 'is not a JSON array' };
    if (set.length === 0) return { set: null, error: 'is an empty array (an empty set verifies nothing)' };

    for (let index = 0; index < set.length; index++) {
        const error = entryError(set[index], index);
        if (error) return { set: null, error };
    }

    let total;
    try {
        total = swq.totalStake(set);
    } catch (error) {
        return { set: null, error: 'has an unusable stake set (' + error.message + ')' };
    }
    if (total.lte(0)) {
        return { set: null, error: 'has zero total stake (the stake-weighted quorum can never be met)' };
    }
    return { set, error: null };
}

module.exports = { parsePinnedSet };
