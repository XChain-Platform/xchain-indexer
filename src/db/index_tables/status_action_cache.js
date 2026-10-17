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
 **********************************************************************
 *
 * XChain Indexer - Transaction-aware status and action id cache
 *
 ********************************************************************/

'use strict';

function read(cache, kind, name, includePending) {
    if(cache.committed[kind].has(name))
        return cache.committed[kind].get(name);
    if(includePending && cache.pending[kind].has(name))
        return cache.pending[kind].get(name);
    return undefined;
}

function remember(cache, kind, name, id, pending) {
    cache[pending ? 'pending' : 'committed'][kind].set(name, id);
}

function promotePending(cache) {
    for(const kind of ['status', 'action']){
        for(const [name, id] of cache.pending[kind])
            cache.committed[kind].set(name, id);
        cache.pending[kind].clear();
    }
}

function clearPending(cache) {
    cache.pending.status.clear();
    cache.pending.action.clear();
}

module.exports = { read, remember, promotePending, clearPending };
