/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * Resolve chain-specific mirror-admission margins at their activation.
 *
 ********************************************************************/

'use strict';

const { get, activeAt } = require('../gate_registry');

const ADMIT_MARGIN_BLOCKS = get('mirror_admission_activation.ADMIT_MARGIN_BLOCKS');
const ADMIT_CHAIN_MARGIN_BLOCKS = get('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_BLOCKS');
const ADMIT_CHAIN_MARGIN_ACTIVATION = get('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION');
const ACTIVATION_KEY = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';

function hasOwn(value, key){
    return Object.prototype.hasOwnProperty.call(value, key);
}

function baseMarginBlocks(table){
    if(table === null || table === undefined) return ADMIT_MARGIN_BLOCKS.default;
    const name = String(table).trim();
    return hasOwn(ADMIT_MARGIN_BLOCKS, name) && name !== 'default'
        ? ADMIT_MARGIN_BLOCKS[name]
        : ADMIT_MARGIN_BLOCKS.default;
}

function chainMarginBlocks(table, chain){
    if(table === null || table === undefined || chain === null || chain === undefined) return null;
    const code = String(chain).trim().toUpperCase();
    const name = String(table).trim();
    if(!hasOwn(ADMIT_CHAIN_MARGIN_BLOCKS, code)) return null;
    const margins = ADMIT_CHAIN_MARGIN_BLOCKS[code];
    return hasOwn(margins, name) ? margins[name] : null;
}

function activationHeight(chain, network){
    if(chain === null || chain === undefined || network === null || network === undefined) return null;
    const code = String(chain).trim().toUpperCase();
    const venue = String(network).trim().toLowerCase();
    const keyed = code + ':' + venue;
    if(hasOwn(ADMIT_CHAIN_MARGIN_ACTIVATION, keyed)) return ADMIT_CHAIN_MARGIN_ACTIVATION[keyed];
    return hasOwn(ADMIT_CHAIN_MARGIN_ACTIVATION, venue) ? ADMIT_CHAIN_MARGIN_ACTIVATION[venue] : null;
}

function stampMarginAt(m, mChain, H, tip){
    if(Number.isFinite(mChain) && Number.isFinite(H) && tip + mChain >= H) return mChain;
    return m;
}

function rowMarginAt(m, mChain, H, admit){
    if(Number.isFinite(mChain) && Number.isFinite(H) && admit >= H) return mChain;
    return m;
}

function consumerTargetAt(m, mChain, H, blockHeight){
    if(!Number.isFinite(mChain) || !Number.isFinite(H) || blockHeight < H) return blockHeight - m;
    return blockHeight - mChain;
}

function isChainMarginActive(chain, network, height){
    if(network === null || network === undefined) return false;
    const code = chain === null || chain === undefined ? null : String(chain).trim().toUpperCase();
    const venue = String(network).trim().toLowerCase();
    if(code === '' || venue === '') return false;
    return activeAt(ACTIVATION_KEY, venue, code, height, null);
}

function stampMarginBlocks(table, chain, network, tip){
    return stampMarginAt(baseMarginBlocks(table), chainMarginBlocks(table, chain),
        activationHeight(chain, network), tip);
}

function rowMarginBlocks(table, chain, network, admit){
    return rowMarginAt(baseMarginBlocks(table), chainMarginBlocks(table, chain),
        activationHeight(chain, network), admit);
}

function consumerTargetHeight(table, chain, network, blockHeight){
    return consumerTargetAt(baseMarginBlocks(table), chainMarginBlocks(table, chain),
        activationHeight(chain, network), blockHeight);
}

module.exports = {
    ADMIT_CHAIN_MARGIN_BLOCKS,
    ADMIT_CHAIN_MARGIN_ACTIVATION,
    baseMarginBlocks,
    chainMarginBlocks,
    activationHeight,
    stampMarginAt,
    rowMarginAt,
    consumerTargetAt,
    isChainMarginActive,
    stampMarginBlocks,
    rowMarginBlocks,
    consumerTargetHeight,
};
