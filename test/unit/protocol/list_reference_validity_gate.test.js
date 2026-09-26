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
 ********************************************************************/

'use strict';

const assert = require('assert');

const gateRegistry = require('../../../src/consensus/gate_registry');

const LIST_REFERENCE_VALIDITY_KEY = 'list_reference_validity_activation.LIST_REFERENCE_REQUIRES_VALID_LIST';
const TOKEN_GATE_LIST_AT_BLOCK_KEY = 'token_gate_list_at_block.TOKEN_GATE_LIST_AT_BLOCK';

describe('LIST reference validity gate ordering @regression @tier1', function () {
    // isActionAllowed omits block context below TOKEN_GATE_LIST_AT_BLOCK. Activating
    // validity first would make every invalid allow-list reference deny all addresses.
    for(const network of ['mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet', 'testnet', 'regtest']){
        it(network + ': never activates before token policy reads carry block context', function () {
            const validity = gateRegistry.get(LIST_REFERENCE_VALIDITY_KEY);
            const policy = gateRegistry.get(TOKEN_GATE_LIST_AT_BLOCK_KEY);
            assert.ok(validity, LIST_REFERENCE_VALIDITY_KEY + ' must be registered');
            assert.ok(policy, TOKEN_GATE_LIST_AT_BLOCK_KEY + ' must be registered');
            assert.ok(validity[network] >= policy[network],
                LIST_REFERENCE_VALIDITY_KEY + ' activates at ' + validity[network] + ' on ' + network +
                ', before ' + TOKEN_GATE_LIST_AT_BLOCK_KEY + ' at ' + policy[network]);
        });
    }
});
