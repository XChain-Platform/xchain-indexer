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

function trustPinEnvNames(network){
    const pin = 'CHECKPOINT_VALIDATORS_BTC_' + String(network).toUpperCase();
    return { pin: pin, next: pin + '_NEXT', from: pin + '_FROM' };
}

function present(raw){
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
}

function staticPin(names, raw){
    return { name: names.pin, raw: present(raw) ? raw : null, error: null };
}

function selectTrustPinRaw(network, snapshotBlock, readEnv = readEnvNow){
    const names = trustPinEnvNames(network);
    const raw = readEnv(names.pin);
    const nextRaw = readEnv(names.next);
    if(!present(nextRaw)) return staticPin(names, raw);

    const fromRaw = readEnv(names.from);
    if(typeof fromRaw !== 'string' || !/^\d+$/.test(fromRaw)){
        return { name: names.from, raw: null, error: names.from + ' must be a decimal safe integer' };
    }

    const from = Number(fromRaw);
    if(!Number.isSafeInteger(from)){
        return { name: names.from, raw: null, error: names.from + ' must be a decimal safe integer' };
    }

    if(snapshotBlock >= from) return { name: names.next, raw: nextRaw, error: null };
    return staticPin(names, raw);
}

module.exports = { trustPinEnvNames, selectTrustPinRaw };
