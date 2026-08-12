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
 **********************************************************************/

'use strict'

/**
 * Parse the CORS_ORIGIN env var into a value the `cors` package matches per-origin.
 *
 * The reason this exists rather than passing the raw string through: `cors`
 * treats a String origin as ONE exact origin and echoes it back verbatim to
 * every caller. So `CORS_ORIGIN="a,b"` emits `Access-Control-Allow-Origin: a,b`
 * to a, to b, and to a hostile origin alike - a multi-value header no browser
 * accepts, which blocks all of them while a header dump reads as configured.
 * The indexer's JSON-RPC surface is called cross-origin by more than one
 * browser shell (the explorer and the wallet builds), so an allowlist is the
 * real shape of the setting and a single string never was.
 *
 * Fails CLOSED on anything ambiguous: an empty or all-blank value disables CORS
 * exactly as an unset var does, and `*` only means "any origin" when it is the
 * entire value. Mixed in with real origins it stays a literal list entry, which
 * no browser sends, so a fat-fingered `*,https://x` grants x and nothing more
 * rather than silently opening the service to everyone.
 *
 * Identical by intent to xchain-encoder/src/corsOrigin.js, xchain-hub's
 * src/lib/corsOrigin.js, and xchain-utxo-tracker/src/corsOrigin.js; keep the
 * four in step.
 *
 * @param {string|undefined|null} raw - the raw CORS_ORIGIN value
 * @returns {false|string|string[]} `false` (disabled), `'*'` (any), one origin, or an allowlist
 */
function parseCorsOrigin (raw) {
    if (raw == null) return false
    const list = String(raw).split(',').map(s => s.trim()).filter(Boolean)
    if (list.length === 0) return false
    if (list.length === 1) return list[0]
    return list
}

module.exports = { parseCorsOrigin }
