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
 * XChain Platform Action - UNSTAKE rotated-key row journal
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry.js');

const GATE = 'unstake_delegated_row_journal_activation.UNSTAKE_DELEGATED_ROW_JOURNAL_ACTIVATION';

module.exports = {

    async journalRotatedContractRows(data, status, contractStake, hasResidual){
        if(status !== 'valid' || !contractStake) return [];
        if(!gateRegistry.activeAt(GATE, this.config['NETWORK'], data['COIN'], data['BLOCK_INDEX'], null))
            return [];

        let origin = await this.indexerDb.getContractStakeRotationOrigin(
            data['TARGET_CONTRACT_INDEX'],
            contractStake.source_id,
            contractStake.tick_id,
            contractStake.signing_pubkey_id
        );
        if(!origin || origin.delegationActionIndex === null ||
           Number(origin.originalPubkeyId) === Number(contractStake.signing_pubkey_id))
            return [];

        let tables = ['contract_unstakes'];
        if(hasResidual) tables.push('contract_stakes');
        for(let table of tables){
            await this.indexerDb.createContractDelegationRotation(
                table,
                origin.delegationActionIndex,
                data['ACTION_INDEX'],
                origin.originalPubkeyId,
                contractStake.signing_pubkey_id,
                data['BLOCK_INDEX']
            );
        }
        return tables;
    },

};
