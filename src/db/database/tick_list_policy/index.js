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
 * XChain Indexer - Token list policy reads and membership checks
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../../consensus/gate_registry');

const TOKEN_GATE_LIST_AT_BLOCK_KEY = 'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK';

function policySet(items){
    return items ? new Set(items) : null;
}

// Gate this SOURCE policy's block-bound read with TOKEN_GATE_LIST_AT_BLOCK.
// Keep AIRDROP recipient policy and membership bound to its action block; its source file
// owns that read, and changing the replay scope requires a separate activation.
async function readTickListPolicy(db, tick, block_index, config=db.config, util=db.util){
    const policyAtBlock = gateRegistry.activeAt(
        TOKEN_GATE_LIST_AT_BLOCK_KEY,
        config['NETWORK'],
        config['COIN'],
        block_index,
        null
    );
    const lookupBlockIndex = policyAtBlock ? block_index : undefined;
    const info = await db.getTokenInfo(tick, lookupBlockIndex);
    const hasAllowList = info && !util.isNull(info['ALLOW_LIST']) && util.isNumeric(info['ALLOW_LIST']);
    const hasBlockList = info && !util.isNull(info['BLOCK_LIST']) && util.isNumeric(info['BLOCK_LIST']);
    const [allowList, blockList] = await Promise.all([
        hasAllowList ? db.getList(info['ALLOW_LIST'], lookupBlockIndex) : Promise.resolve(null),
        hasBlockList ? db.getList(info['BLOCK_LIST'], lookupBlockIndex) : Promise.resolve(null)
    ]);
    return { allow: policySet(allowList), block: policySet(blockList) };
}

function isAddressAllowedByTickPolicy(address, policy){
    if(policy.allow && !policy.allow.has(address))
        return false;
    if(policy.block && policy.block.has(address))
        return false;
    return true;
}

module.exports = { readTickListPolicy, isAddressAllowedByTickPolicy };
