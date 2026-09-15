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
 * test/unit/protocol/emission_issuance_limits.test/helpers/emission_budget_fixtures.js
 *
 * The gate name and the block height the emission-issuance-budget suite shares
 * (emission_issuance_limits.test.js plus the files in
 * emission_issuance_limits.test/).
 ********************************************************************/

'use strict';

const GATE = 'EMISSION_ISSUANCE_LIMITS';

// Below 862633 the ISSUANCE_FEE gate is off, so a new token needs no GAS balance.
const LOW_BLOCK = 100;

module.exports = { GATE, LOW_BLOCK };
