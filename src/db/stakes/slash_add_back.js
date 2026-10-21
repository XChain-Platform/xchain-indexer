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
 * XChain Indexer - stakes / slash_add_back
 *
 * The SQL fragments that read a capability stake row's amount AS IT STOOD at a past height.
 * slashCapabilityStake zeroes a burned stakes row in place and logs the amount it took in
 * capability_slash_debits at the slash block, so the row's amount at height h is its current
 * amount plus every debit on it whose block_index is above h. From
 * slash_historical_set_activation (judged at the read height) the effective set, the source
 * stake weights and the per-key membership test sum that amount; below it they sum the current
 * amount and every fragment here renders to the text those queries already carried. Pure: no
 * method lands on Database.prototype, so a stub db that borrows one prototype method still
 * resolves these.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const SLASH_HISTORICAL_SET_KEY = 'slash_historical_set_activation.SLASH_HISTORICAL_SET_ACTIVATION';

// Whether a capability read at `blockIndex` adds back the slash debits recorded above it.
// Judged on this chain's network and coin at the height the set is read for.
function slashHistoricalSetActive(config, blockIndex){
    const c = config || {};
    return gateRegistry.activeAt(SLASH_HISTORICAL_SET_KEY, c['NETWORK'], c['COIN'], Number(blockIndex), null);
}

// The amount of stakes row `alias` summed by a set read: armed, the current amount plus what
// later slashes burned from it (joined by laterBurnsJoin); unarmed, the current amount.
function stakeAmountAt(alias, armed){
    if(!armed) return `CAST(${alias}.amount AS DECIMAL(30,8))`;
    return `CAST(${alias}.amount AS DECIMAL(30,8))
                              + COALESCE(CAST(${alias}_burned.amt AS DECIMAL(30,8)), 0)`;
}

// Armed, the join that carries each stakes row's burns from slashes above the read height,
// one row per burned stakes row so the outer SUM counts each stake row once. Its one
// placeholder is the read height and precedes the placeholders of the WHERE it joins into
// (laterBurnsArgs). Unarmed, nothing. Unstakes debits never feed a set read: a cooling row is
// outside every set already.
function laterBurnsJoin(alias, armed){
    if(!armed) return '';
    return `
                   LEFT JOIN (
                       SELECT csd.stake_action_index AS stake_action_index,
                              SUM(CAST(csd.amount AS DECIMAL(30,8))) AS amt
                       FROM capability_slash_debits csd
                       WHERE csd.target_table = 'stakes' AND csd.block_index > ?
                       GROUP BY csd.stake_action_index
                   ) ${alias}_burned ON ${alias}_burned.stake_action_index = ${alias}.action_index`;
}

// The arguments laterBurnsJoin's placeholder binds: the read height when armed, none otherwise.
function laterBurnsArgs(blockIndex, armed){
    return armed ? [blockIndex] : [];
}

module.exports = { slashHistoricalSetActive, stakeAmountAt, laterBurnsJoin, laterBurnsArgs };
