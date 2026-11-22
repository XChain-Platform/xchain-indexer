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
 * XChain Platform Indexer - pre-flight verdict memo.
 *
 * Bounded LRU keyed by a fixed-size digest of (action, params-as-wire, source,
 * blockIndex, variant). A public
 * validity dry-run contends with block processing on the shared tx
 * mutex, so an identical re-run at the same height is pure waste. The
 * blockIndex is PART of the key: a new tip changes every key, so a
 * verdict is only ever served for the exact height it was computed at,
 * and stale entries age out of the LRU as fresh-height keys push them
 * past the cap. No block-event hook is needed to invalidate.
 *
 * A reorg that rewrites history at the same height is the one case the
 * key alone cannot catch; the LRU cap keeps any such window tiny, and
 * pre-flight is best-effort by contract (the chain is the arbiter).
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

class PreflightMemo {
    constructor(maxEntries = 256) {
        this.max = maxEntries;
        this._map = new Map(); // insertion-ordered; re-insert on hit for LRU
    }

    // `variant` distinguishes verdicts computed under different dry-run assumptions at the
    // same height (today: the fee settlement mode). The JSON array keeps every field boundary
    // unambiguous for arbitrary content, and hashing keeps caller-sized text out of Map keys.
    // BATCH raw wire receives the same treatment as `p`.
    key(action, params, source, blockIndex, variant) {
        const p = Array.isArray(params) ? params.join('|') : String(params == null ? '' : params);
        const material = JSON.stringify([
            String(action),
            p,
            String(source == null ? '' : source),
            String(blockIndex),
            String(variant == null ? '' : variant)
        ]);
        return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
    }

    get(key) {
        if (!this._map.has(key)) return null;
        const value = this._map.get(key);
        // LRU touch: delete + re-insert moves it to the newest position.
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key, value) {
        if (this._map.has(key)) this._map.delete(key);
        this._map.set(key, value);
        while (this._map.size > this.max) {
            const oldest = this._map.keys().next().value;
            this._map.delete(oldest);
        }
        return value;
    }

    get size() { return this._map.size; }
    clear() { this._map.clear(); }
}

module.exports = PreflightMemo;
