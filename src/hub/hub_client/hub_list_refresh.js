// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { parseHubList } = require('./hub_list');

const UNKNOWN_METHOD_CODE = -32601;

function createHubListRefresher({ fetchList, merge, warn }){
    let warnedEmpty = false;
    let warnedUnknownMethod = false;

    async function safeWarn(message, err){
        try {
            await warn(message, err);
        } catch (warnErr) {
            return;
        }
    }

    async function refresh(){
        let result;
        try {
            result = await fetchList();
        } catch (err) {
            if(err && (err.rpcCode === UNKNOWN_METHOD_CODE || err.code === UNKNOWN_METHOD_CODE)){
                if(!warnedUnknownMethod){
                    warnedUnknownMethod = true;
                    await safeWarn('Hub list refresh is unavailable because the followed hub does not support it.', err);
                }
                return { outcome: 'unknown-method', count: 0 };
            }

            await safeWarn('Hub list refresh failed.', err);
            return { outcome: 'error', count: 0 };
        }

        let addresses = parseHubList(result);
        if(addresses.length === 0){
            if(!warnedEmpty){
                warnedEmpty = true;
                await safeWarn('Hub list refresh returned no usable addresses.');
            }
            return { outcome: 'empty', count: 0 };
        }

        try {
            await merge(addresses);
            return { outcome: 'merged', count: addresses.length };
        } catch (err) {
            await safeWarn('Hub list merge failed.', err);
            return { outcome: 'error', count: 0 };
        }
    }

    return { refresh };
}

module.exports = { createHubListRefresher };
