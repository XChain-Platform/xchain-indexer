/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const { readEnvNow } = require('../../config.js');
const { trustPinEnvNames } = require('./trust_pin.js');
const { parsePinnedSet } = require('./pinned.js');

function errorMessage(error){
    try {
        return error && typeof error.message === 'string' ? error.message : String(error);
    } catch (_) {
        return 'unknown error';
    }
}

function readValue(readEnv, name){
    try {
        return { value: readEnv(name), error: null };
    } catch (error) {
        return { value: undefined, error: name + ' could not be read (' + errorMessage(error) + ')' };
    }
}

function parsePin(raw){
    try {
        return parsePinnedSet(raw);
    } catch (error) {
        return { set: null, error: 'could not be parsed (' + errorMessage(error) + ')' };
    }
}

function isSet(raw){
    try {
        return raw !== undefined && raw !== null && String(raw).trim() !== '';
    } catch (_) {
        return true;
    }
}

function validFrom(raw){
    if(typeof raw !== 'string' || !/^\d+$/.test(raw)) return false;
    return Number.isSafeInteger(Number(raw));
}

function refusal(names, detail){
    const requirement = names.pin + ' or ' + names.next + ' with ' + names.from;
    return 'Startup refused: configure a valid checkpoint validator pin in ' + requirement +
        (detail ? ' (' + detail + ')' : '');
}

/**
 * Decide whether startup must stop until an armed mirror-backed chain is pinned.
 * @param {{network: string, resolvesFromMirror: boolean, gateArmed: boolean} | null} opts startup state
 * @param {function(string): (string | undefined)} readEnv call-time environment reader
 * @returns {string | null} refusal message, or null when startup may continue
 */
function startupPinRefusal(opts, readEnv = readEnvNow){
    let names;
    try {
        if(!opts || opts.resolvesFromMirror !== true || opts.gateArmed !== true) return null;
        if(opts.network !== 'testnet' && opts.network !== 'mainnet') return null;

        names = trustPinEnvNames(opts.network);
        const current = readValue(readEnv, names.pin);
        const next = readValue(readEnv, names.next);
        const from = readValue(readEnv, names.from);
        const currentParsed = current.error ? { set: null, error: current.error } : parsePin(current.value);
        if(currentParsed.set) return null;

        const nextParsed = next.error ? { set: null, error: next.error } : parsePin(next.value);
        if(nextParsed.set && !from.error && validFrom(from.value)) return null;

        const detail = isSet(current.value) ? names.pin + ' ' + currentParsed.error : current.error;
        return refusal(names, detail);
    } catch (error) {
        if(names) return refusal(names, 'pin validation failed: ' + errorMessage(error));
        return 'Startup refused: checkpoint validator pin validation failed (' + errorMessage(error) + ')';
    }
}

module.exports = { startupPinRefusal };
