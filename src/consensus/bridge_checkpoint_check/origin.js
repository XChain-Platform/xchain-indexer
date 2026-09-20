/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { ESCROW_CHAIN } = require('./reasons.js');

/**
 * Derive the native asset and the chain holding its escrow from signed transfer fields.
 * A bare token is a lock from src_chain. A rooted token is a burn only when its root is
 * dest_chain. XCHAIN keeps its protocol-defined BTC origin in both directions.
 *
 * @param {Object} row - bridge transfer fields { src_chain, dest_chain, tick }
 * @returns {{originChain: string, nativeTick: string, kind: 'lock'|'burn'}|null}
 */
function resolveTransferOrigin(row){
    if(!row || typeof row !== 'object') return null;
    const srcChain  = String(row.src_chain || '');
    const destChain = String(row.dest_chain || '');
    const tick      = String(row.tick || '');
    if(!srcChain || !destChain || !tick || srcChain === destChain) return null;

    if(tick.toUpperCase() === 'XCHAIN'){
        if(srcChain === ESCROW_CHAIN)
            return { originChain: ESCROW_CHAIN, nativeTick: tick, kind: 'lock' };
        if(destChain === ESCROW_CHAIN)
            return { originChain: ESCROW_CHAIN, nativeTick: tick, kind: 'burn' };
        return null;
    }

    const parts = tick.split('.');
    if(parts.length === 1)
        return { originChain: srcChain, nativeTick: tick, kind: 'lock' };
    if(parts.length === 2 && parts[0] && parts[1] &&
       parts[0].toUpperCase() === destChain.toUpperCase())
        return { originChain: destChain, nativeTick: parts[1], kind: 'burn' };
    return null;
}

module.exports = { resolveTransferOrigin };
