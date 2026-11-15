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
 * The count quorum used by ANCHOR checkpoint verification
 * and reward-attestation re-verification.
 *
 ********************************************************************/

'use strict';

function meetsCountThreshold(n, signerCount){
    const threshold = n <= 1 ? 1 : Math.max(
        2 * Math.floor((n - 1) / 3) + 1,
        Math.ceil((n + 1) / 2));
    return signerCount >= threshold;
}

module.exports = { meetsCountThreshold };
