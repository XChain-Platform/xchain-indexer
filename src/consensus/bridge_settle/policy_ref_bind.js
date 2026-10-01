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
 * XChain Platform - bridge settle pass: bind a shared-list policy reference.
 *
 ********************************************************************/

'use strict';

const CHAINS = new Set(['BTC', 'LTC', 'DOGE']);

function refIndex(ref){
    if(!ref || typeof ref !== 'object' || !CHAINS.has(ref.chain)){
        throw new TypeError('ref must name a supported chain and positive safe integer index');
    }

    const raw = ref.index;
    const canonicalString = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw);
    const index = typeof raw === 'number' || canonicalString ? Number(raw) : NaN;
    if(!Number.isSafeInteger(index) || index <= 0){
        throw new TypeError('ref must name a supported chain and positive safe integer index');
    }
    return index;
}

async function bindPolicyRef(db, { ref, coin, blockIndex }){
    const index = refIndex(ref);
    if(ref.chain === coin){
        const type = await db.getListType(index, blockIndex);
        return type === 2 ? { index } : { pending: true };
    }

    const mirror = await db.getListShareMirror(ref.chain, index);
    return mirror ? { index: Number(mirror.action_index) } : { pending: true };
}

function refNeedsPointer(currentPointer, boundIndex){
    return currentPointer === null || currentPointer === '' || Number(currentPointer) !== Number(boundIndex);
}

module.exports = { bindPolicyRef, refNeedsPointer };
