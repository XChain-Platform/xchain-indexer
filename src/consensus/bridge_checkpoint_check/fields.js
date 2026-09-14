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
 * XChain Platform - the escrow cross-check: how a field off the row or the envelope is read.
 *
 * Every coercion the check applies, in one place, because each one of them is a refusal rule:
 * a field that does not coerce is malformed input the check must refuse rather than something
 * to String() into a key preimage.
 *
 ********************************************************************/

'use strict';

const M = require('../merkle.js');

// A non-empty string, or null. Used for every field taken off the row or the envelope:
// a number, a Buffer or an object where a chain or an address belongs is malformed input,
// not something to String() into a key preimage.
function str(v){
    if(typeof v !== 'string') return null;
    const s = v.trim();
    return s.length ? s : null;
}

// A finite non-negative integer height, or null. Heights arrive from a MariaDB driver that
// may hand back a number, a string or a BigInt depending on its bigint options, so the
// conversion is pinned here rather than trusted from the call site.
function height(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    if(!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
}

// A strict non-negative version integer, or null. Deliberately NOT a bare Number(): that
// reads true as 1, ' 1 ' as 1 and null as 0, so a field that is not a version at all would
// compare equal to a derived version of 1 and pass. Shape follows _strictHeight in
// state_subtree_activation.js, plus the BigInt case the MariaDB driver can hand back.
function version(v){
    if(typeof v === 'bigint')
        return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = (typeof v === 'number') ? v
            : (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v)
            : NaN;
    return (Number.isInteger(n) && n >= 0) ? n : null;
}

// A canonical amount scaled to an exact 18-dp integer, or null when the input is not a
// non-negative decimal. BigInt rather than mathjs: the comparison is exact, and it cannot
// depend on a bignumber config that the producer of the proof does not share.
function scaled(amount){
    if(typeof amount !== 'string' && typeof amount !== 'number') return null;
    let canon;
    try { canon = M.canonicalAmount(String(amount).trim()); }
    catch(e){ return null; }
    const [i, f] = canon.split('.');
    return BigInt(i) * 1000000000000000000n + BigInt(f);
}

module.exports = { str, height, version, scaled };
