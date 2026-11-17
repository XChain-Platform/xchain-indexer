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
 * The text a contract state value is stored as in contract_state.state_value.
 *
 * WHY THIS EXISTS
 * ---------------
 * state_value is MEDIUMTEXT in a utf8mb3 table (src/sql/contract_state.sql), which
 * holds at most three bytes per character. A contract may set a value holding a
 * character above U+FFFF (any emoji), JSON.stringify writes that character raw, and
 * under the pinned STRICT_TRANS_TABLES session (db/shared.js SESSION_SQL_MODE) the
 * INSERT fails with errno 1366. fault_guard rethrows any errno, so the block retries
 * forever and every indexer halts at the same height.
 *
 * At and after the STATE_VALUE_ASTRAL_ESCAPE protocol change, every astral character
 * in the JSON text is written as its JSON escape pair instead (U+1F600 becomes the
 * twelve ASCII bytes 😀). JSON.parse of the escaped text returns the
 * identical value, so the reload path (db.getContractState), the explorer and every
 * other JSON reader see the same value, and the stored text is plain BMP that utf8mb3
 * accepts.
 *
 * WHY THE ESCAPE IS ALWAYS WELL-FORMED: JSON structural characters are ASCII, so a raw
 * astral character can only sit inside a string literal (a key or a value), and it is
 * never itself part of an escape sequence. Writing its two \uXXXX escapes in its place
 * is therefore a legal JSON escape wherever it occurs. Lone surrogates never reach this
 * point raw: JSON.stringify already emits them as \udXXX escapes, in lowercase hex,
 * and this file uses the same spelling so one stored text has one form.
 *
 * CONSENSUS: the stored text is hashed as is into contract_hash (db.getBlockHashes)
 * and into the contract-state SMT leaf (consensus/contract_state_subtree.js), so the
 * escape spelling (lowercase hex, two escapes per pair) is frozen. No row before the
 * change can hold an astral character, because the INSERT that would have stored one
 * failed and halted the block; so text that holds none is byte-identical on both sides
 * of the change, and the gate only decides whether an astral value halts or stores.
 *
 * The VM's value limits are measured on JSON.stringify(value) inside the VM
 * (xchain-vm src/state.js maxStateValueSize) before the value reaches this writer, so
 * the escape changes no gas, no limit and no verdict.
 *
 ********************************************************************/

'use strict';

// Protocol-change name every contract_state writer gates on.
const STATE_VALUE_ASTRAL_ESCAPE = 'STATE_VALUE_ASTRAL_ESCAPE';

// A surrogate pair is how a JS string holds one character above U+FFFF.
const SURROGATE_PAIR   = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
const SURROGATE_PAIRS  = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

// '\u' plus four lowercase hex digits, the spelling JSON.stringify uses for a lone surrogate.
function unicodeEscape(codeUnit){
    return '\\u' + codeUnit.toString(16).padStart(4, '0');
}

// JSON text with each astral character replaced by its escape pair.
function escapeAstral(jsonText){
    return jsonText.replace(SURROGATE_PAIRS,
        (pair) => unicodeEscape(pair.charCodeAt(0)) + unicodeEscape(pair.charCodeAt(1)));
}

/**
 * The stored texts for one writer call's state changes, in order.
 *
 * The gate is read at most once per call, and only when some value's JSON holds an
 * astral character: for any other value the text is the same on both sides of the
 * change, so the lookup (a decoder block-time read) could not change the answer. The
 * ProtocolChanges instance is fetched through a getter for the same reason: a writer
 * whose values hold no astral character never touches it.
 *
 * @param {function(): object} getProtocolChanges  returns the ProtocolChanges instance (isEnabled)
 * @param {*}      blockIndex       the block being processed
 * @param {Array}  changes          the VM's stateChanges ({ key, value } rows)
 * @returns {Promise<string[]>} one state_value text per change
 */
async function stateValueTexts(getProtocolChanges, blockIndex, changes){
    const texts = changes.map((change) => JSON.stringify(change.value));
    if(!texts.some((text) => SURROGATE_PAIR.test(text)))
        return texts;
    if(!(await getProtocolChanges().isEnabled(STATE_VALUE_ASTRAL_ESCAPE, blockIndex)))
        return texts;
    return texts.map(escapeAstral);
}

module.exports = {
    STATE_VALUE_ASTRAL_ESCAPE,
    escapeAstral,
    stateValueTexts,
};
