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
 *
 * Decide the stamp margin, row margin, and consumer target at the
 * mirror-admission boundary.
 *
 ********************************************************************/

'use strict';

function stampMarginAt(m, mChain, H, tip){
    if(Number.isFinite(mChain) && Number.isFinite(H) && tip + mChain >= H) return mChain;
    return m;
}

function rowMarginAt(m, mChain, H, admit){
    if(Number.isFinite(mChain) && Number.isFinite(H) && admit >= H) return mChain;
    return m;
}

function consumerTargetAt(m, mChain, H, B){
    if(!Number.isFinite(mChain) || !Number.isFinite(H) || B < H) return B - m;
    return B - mChain;
}

module.exports = { stampMarginAt, rowMarginAt, consumerTargetAt };
