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
 * Indexer registry rows, part 5.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED } = require('./shared_rows.js');

// vm_lint_destructure_heights
// Per-chain deploy-lint ObjectPattern refinement. Public networks remain
// unarmed until release heights are chosen. MUST equal xchain-vm
// LINT_DESTRUCTURE_ACTIVATION; VM null is UNARMED here.
addGate('vm_lint_destructure_heights.VM_LINT_DESTRUCTURE_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});
