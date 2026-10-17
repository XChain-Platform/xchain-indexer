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
 ********************************************************************/

'use strict';

const BALANCE_DELTA_MODES = ['off', 'verify', 'on'];

function resolveBalanceDeltaMode(raw){
    if(raw === undefined || raw === null) return 'off';

    const mode = String(raw).trim().toLowerCase();
    if(mode === '') return 'off';
    if(BALANCE_DELTA_MODES.includes(mode)) return mode;

    throw new Error(
        `BALANCE_DELTA_MODE must be one of: ${BALANCE_DELTA_MODES.join(', ')}`
    );
}

module.exports = { BALANCE_DELTA_MODES, resolveBalanceDeltaMode };
