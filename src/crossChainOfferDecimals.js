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
 * Give-side decimal grid for the cross-chain DEX book ().
 *
 * The hub derives cross-chain fill quantities that no single indexer can compute
 * (each leg lives on a different chain) and must snap each derived amount onto the
 * same decimal grid the LOCAL matcher uses - actions/order_match.js finishes its
 * bottleneck clamp with bcround(amount, <that tick's DECIMALS>). Without that, the
 * hub can finalize a fill in sub-unit digits no indexer will reproduce, which
 * livelocks settlement, and for a 0-decimal (NFT) tick it can propose a fractional
 * quantity outright.
 *
 * The hub mirrors no token table and must never infer decimals (an 8-decimal
 * assumption mis-quantizes every 0-decimal and non-8-decimal tick, which is worse
 * than not rounding at all), so each offer carries the grid of the side it GIVES,
 * reported by the one node that is authoritative for that tick: its home indexer.
 * An offer's GET tick lives on the other chain and is absent from this indexer's
 * token table, so it is deliberately NOT reported here; the hub pairs each derived
 * amount with the decimals of whichever leg gives it, which is also exactly the
 * amount that leg later settles.
 *
 * Extracted from the getopencrosschainorders handler so the resolution is unit
 * testable: startApi() runs at module load, so src/api.js cannot be required.
 *
 ********************************************************************/

'use strict';

// Resolve and stamp `give_decimals` on every offer of one book page, in place.
//
// Resolution is delegated to db.getTokenInfo, NOT re-derived from tokens.decimals:
// that function owns the real rule (multi-ISSUE merge in which precision may only
// increase, and a NULL decimals column meaning 0) and is the same function
// order_match.js itself calls, which is what makes the two sides byte-equivalent by
// construction rather than by a comment. A tick with no token row - a native-coin
// give side - falls back to this chain's COIN_DECIMALS, mirroring order_match's
// `giveTokenInfo ? giveTokenInfo['DECIMALS'] : config['COIN_DECIMALS']`.
//
// getTickerId is consulted FIRST and getTokenInfo is skipped when it returns null,
// because getTokenInfo resolves its tick through createTicker, which INSERTS an
// index_tickers row for an unknown tick. On a federation read path that would be an
// out-of-band index-id assignment (#5052): it offsets the deterministic dense
// counter that wire ^<id> references and the index-map state-hash class depend on.
// Every open offer's tick necessarily already has an id (the offer row references
// give_tick_id), so the pre-check costs one cached lookup and makes that insert
// branch unreachable rather than merely unlikely.
//
// One lookup per DISTINCT tick per page, so a 500-offer book of a few ticks costs a
// few queries. `blockIndex` is the tip this response is pinned to, so the reported
// grid is the grid as of the same view every other field in the response reflects.
async function stampGiveDecimals(db, util, coinDecimals, offers, blockIndex) {
    let fallback = parseInt(coinDecimals);
    let byTick   = new Map();
    for (let offer of (offers || [])) {
        let tick = (offer.give_tick === null || offer.give_tick === undefined) ? '' : String(offer.give_tick);
        if (!byTick.has(tick)) {
            let tickId = tick ? await db.getTickerId(tick) : null;
            let info   = (tickId !== null && tickId !== undefined) ? await db.getTokenInfo(tick, blockIndex) : null;
            byTick.set(tick, (info && !util.isNull(info['DECIMALS'])) ? parseInt(info['DECIMALS']) : fallback);
        }
        offer.give_decimals = byTick.get(tick);
    }
    return offers;
}

module.exports = { stampGiveDecimals };
