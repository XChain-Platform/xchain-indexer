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

const { describeMeterTwinParity } = require('./support/meter_twin_parity.js');

describeMeterTwinParity({
    name: 'TOSTRING_SIZE_METER',
    slug: 'tostring_size_meter',
    vmModule: 'src/index/tostring_size_meter.js',
    activationExport: 'TOSTRING_SIZE_METER_ACTIVATION',
    predicateExport: 'isToStringSizeMeterActive',
    testnetTime: 1792454400,
    registrationTitle: 'registers the time-table row in part 5, unarmed on mainnet, armed on testnet at its v0.25.0 instant, live on regtest',
});
