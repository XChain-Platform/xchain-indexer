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
 * SLASH content readers: the two signed-content shapes whose EQUIV key does not
 * carry the slot's block, so the pair is discriminated on fields INSIDE the
 * signed JSON instead. They live apart from the handler because they are pure
 * byte readers with no handler state: given a content string they answer what it
 * declares, and every "is this pair really one slot" rule that uses them stays in
 * resolve_slot.js.
 *
 ********************************************************************/

// Read the (round, btc_block_height) pair out of an XORACLE signed content.
// The content is ed25519.buildPriceV0Payload's JSON.stringify output, so a parse failure
// or a non-integer field means "this content does not declare the value" (null), never a
// zero: coercing an absent round to 0 would make two absent rounds compare EQUAL and
// re-open the false-pair hole this exists to close.
function parseOracleContent(content){
    let obj = null;
    try { obj = JSON.parse(String(content)); } catch(e){ return null; }
    if(obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let num = (v) => Number.isInteger(v) ? v : null;
    return { round: num(obj.round), height: num(obj.btc_block_height) };
}

// Read the (first_round, last_round, btc_block_height) triple out of an XORACLEB signed
// content (ed25519.buildPriceBatchPayload's JSON.stringify output). A batch declares a
// WINDOW and no scalar `round`, which is why it carries its own engine tag and its own
// reader here. Same null discipline as parseOracleContent: an absent or non-integer field
// yields null rather than 0, so two absent windows never compare EQUAL and re-open the
// false-pair hole.
function parseBatchContent(content){
    let obj = null;
    try { obj = JSON.parse(String(content)); } catch(e){ return null; }
    if(obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let num = (v) => Number.isInteger(v) ? v : null;
    return { first: num(obj.first_round), last: num(obj.last_round), height: num(obj.btc_block_height) };
}

module.exports = { parseOracleContent, parseBatchContent };
