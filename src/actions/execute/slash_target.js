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
 * XChain Platform Action - EXECUTE : SLASH target lookup
 *
 * Resolves a SLASH emission's contract, pubkey and token to the rows the
 * deduction in ./slash_emission.js needs. Called with the action handler as
 * `this`, the same receiver the writer runs with (EXECUTE or DEPLOY).
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// The emission's target, resolved to the rows the deduction needs, or null when
// there is nothing to deduct. A null return is a logged no-op, never an error:
// a contract may slash a pubkey or a token this chain has never seen.
async function resolveSlashTarget(emission, data){
    let p = emission.params || {};
    let contractIndex = Number(p.contractIndex);
    let pubkey        = String(p.pubkey || '').toLowerCase();
    let token         = String(p.token || '');
    let amount        = String(p.amount || '0');

    // Defense in depth: caller mismatch should never happen if the gateway
    // closure is sourced correctly, but throw if it does (rolls back the savepoint).
    if(contractIndex !== Number(data['CONTRACT_ACTION_INDEX']))
        throw new Error('SLASH emission contractIndex mismatch: ' + contractIndex + ' vs ' + data['CONTRACT_ACTION_INDEX']);

    // Load contract row to fetch slash_destination_id (locked at DEPLOY time)
    let contractInfo = await this.indexerDb.getContract(contractIndex);
    if(!contractInfo)
        throw new Error('SLASH: contract not found: ' + contractIndex);
    if(contractInfo.slash_destination_id === null || contractInfo.slash_destination_id === undefined)
        throw new Error('SLASH: contract has no slash destination configured');

    // Resolve FKs
    let pubkeyId = await this.indexerDb.getPubkeyId(pubkey);
    if(pubkeyId === null){
        // pubkey is not known to index_pubkeys at all: not staked anywhere on this
        // chain. Nothing to deduct; log for auditability so the no-op is visible.
        getLogger().info('\t SLASH (no-op): pubkey not found in index_pubkeys: ' + pubkey +
            ' contract=' + contractIndex + ' token=' + token);
        return null;
    }
    let tickId = await this.indexerDb.getTickerId(token);
    if(tickId === null){
        // token is unknown. Nothing to deduct; log for auditability.
        getLogger().info('\t SLASH (no-op): token not found: ' + token +
            ' pubkey=' + pubkey + ' contract=' + contractIndex);
        return null;
    }
    return { contractIndex, pubkey, token, amount, contractInfo, pubkeyId, tickId };
}

module.exports = { resolveSlashTarget };
