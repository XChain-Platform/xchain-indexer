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
 * Judges whether mirror readings cover a retroactive replay target.
 *
 *********************************************************************/

'use strict';

const PRICE_HORIZON_SLOP_SECONDS = 86400;

function requiredPriceFloor(targetBlockTime, fiatWindowSeconds){
    if(!Number.isFinite(targetBlockTime) || targetBlockTime <= 0)
        throw new TypeError('targetBlockTime must be a positive finite number');
    if(!Number.isSafeInteger(fiatWindowSeconds) || fiatWindowSeconds <= 0)
        throw new TypeError('fiatWindowSeconds must be a positive safe integer');

    return targetBlockTime - (2 * fiatWindowSeconds) - PRICE_HORIZON_SLOP_SECONDS;
}

function finiteReading(value, name){
    const reading = Number(value);
    if(!Number.isFinite(reading))
        throw new TypeError(`${name} must be finite after numeric conversion`);
    return reading;
}

function mirrorCoverageGap({
    targetBlockTime,
    fiatWindowSeconds,
    oldestPriceRoundTime,
    requiredCapabilityBlock,
    oldestCapabilitySnapshotBlock
}){
    const priceFloor = requiredPriceFloor(targetBlockTime, fiatWindowSeconds);
    if(oldestPriceRoundTime === null || oldestPriceRoundTime === undefined)
        return 'price_mirror_empty';

    const oldestPrice = finiteReading(oldestPriceRoundTime, 'oldestPriceRoundTime');
    if(oldestPrice > priceFloor)
        return `price_mirror_horizon:${oldestPrice}>${priceFloor}`;

    if(requiredCapabilityBlock === null || requiredCapabilityBlock === undefined)
        return null;
    if(oldestCapabilitySnapshotBlock === null || oldestCapabilitySnapshotBlock === undefined)
        return 'capability_snapshots_empty';

    const oldestSnapshot = finiteReading(
        oldestCapabilitySnapshotBlock,
        'oldestCapabilitySnapshotBlock'
    );
    const requiredSnapshot = finiteReading(requiredCapabilityBlock, 'requiredCapabilityBlock');
    if(oldestSnapshot > requiredSnapshot)
        return `capability_snapshot_horizon:${oldestSnapshot}>${requiredSnapshot}`;

    return null;
}

module.exports = {
    PRICE_HORIZON_SLOP_SECONDS,
    requiredPriceFloor,
    mirrorCoverageGap,
};
