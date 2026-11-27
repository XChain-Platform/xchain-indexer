/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const EXECUTE_NATIVE_METERED_GAS_KEY =
    'execute_native_metered_gas_activation.EXECUTE_NATIVE_METERED_GAS_ACTIVATION';

function executeNativeMeteredGasActive(holder, blockIndex){
    return gateRegistry.activeAt(EXECUTE_NATIVE_METERED_GAS_KEY,
        holder.config['NETWORK'], holder.config['COIN'], Number(blockIndex), null);
}

module.exports = { executeNativeMeteredGasActive };
