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
 * A stand-in for the live indexer the JSON-RPC route families close over.
 *
 * Every handler reaches its database through indexer.indexerDb.apiView() (or
 * committedView, which calls the same method), so a family is driven end to
 * end by handing it a view whose accessors answer canned rows and record the
 * order they were called in. The order is what several guards are about: a
 * push generation read after the rows it fences is the defect the stamping
 * handlers exist to prevent.
 */

'use strict';

// Wrap each accessor so every call lands in `calls` as [name, ...args] before
// the canned answer (a value, or a function of the args) is returned. A
// `sync` accessor answers without a promise, the way isCapabilityConfigured does.
function recordingView(accessors, { sync = [] } = {}) {
    const calls = [];
    const view = { calls };
    for (const [name, impl] of Object.entries(accessors)) {
        const answer = (args) => (typeof impl === 'function' ? impl(...args) : impl);
        view[name] = sync.includes(name)
            ? (...args) => { calls.push([name, ...args]); return answer(args); }
            : async (...args) => { calls.push([name, ...args]); return answer(args); };
    }
    return view;
}

// The indexer double: config as the handlers read it, both database handles
// answering apiView() with the given views, and whatever else a test overrides.
function fakeIndexer({ view = recordingView({}), decoderView = recordingView({}), config = {}, ...rest } = {}) {
    return Object.assign({
        config:    Object.assign({ COIN: 'BTC', NETWORK: 'regtest', COIN_DECIMALS: 8 }, config),
        indexerDb: { apiView: () => view, circuitState: 'closed' },
        decoderDb: { apiView: () => decoderView, circuitState: 'closed' },
        lastDecoderBlock: null,
    }, rest);
}

// The order two named accessors were called in: negative when `first` never ran.
function callOrder(view, first, second) {
    const a = view.calls.findIndex(c => c[0] === first);
    const b = view.calls.findIndex(c => c[0] === second);
    return { first: a, second: b, ordered: a !== -1 && b !== -1 && a < b };
}

module.exports = { recordingView, fakeIndexer, callOrder };
