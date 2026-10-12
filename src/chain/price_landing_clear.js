/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The price_landing_clear frontier of getlatestblock: the highest decoder block
 * reachable from the delivered frontier without crossing a PRICE action. Blocks
 * in (delivered, clear] carry no PRICE row, so a price round anchored there has
 * not landed and the consumer may treat them as safe to read past.
 *
 * Soundness leans on over-matching: a row that cannot be classified counts as a
 * PRICE row, which only ever shortens the clear range.
 *
 ********************************************************************/

'use strict';

// Whether a decoder transaction row is a PRICE action. The action name is the first
// pipe field, compared trimmed and case-insensitively. A missing row or a row whose
// payload is not a string cannot be ruled out, so it answers true.
function isPriceRow(row){
    if(row == null || typeof row.data !== 'string') return true;
    return row.data.split('|', 1)[0].trim().toLowerCase() === 'price';
}

// The clear block given the delivered frontier, the decoder tip and the first block
// above the frontier that holds a PRICE row (null when none does). Null when the
// inputs are not coherent, so unknown is never published as clear.
function clearBlock({ delivered, decoderTip, firstPriceBlock }){
    if(!Number.isFinite(delivered) || !Number.isFinite(decoderTip)) return null;
    if(decoderTip < delivered) return null;
    if(firstPriceBlock == null) return decoderTip;
    if(!Number.isFinite(firstPriceBlock) || firstPriceBlock <= delivered) return null;
    return Math.min(decoderTip, firstPriceBlock - 1);
}

module.exports = { isPriceRow, clearBlock };
