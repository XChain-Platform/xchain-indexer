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

const { isNull } = require('./reasons.js');

function planListLeg({ list, hasField, detachActive, existingIndex }){
    if(!hasField) return { op: 'skip' };
    if(list === null){
        if(detachActive && !isNull(existingIndex)) return { op: 'detach' };
        return { op: 'skip' };
    }
    return { op: isNull(existingIndex) ? 'create' : 'edit' };
}

module.exports = { planListLeg };
