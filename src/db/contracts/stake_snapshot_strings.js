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
 * Convert a VM stake snapshot's amounts to plain decimal strings without
 * changing the snapshot or its staker arrays.
 *
 ********************************************************************/

function amountStrings(util, amounts){
    return Object.fromEntries(Object.entries(amounts).map(([key, amount]) => [key, util.bcstr(amount)]));
}

function stakerStrings(util, stakersByTick){
    return Object.fromEntries(Object.entries(stakersByTick).map(([tick, stakers]) => [
        tick,
        stakers.map(({ pubkey, amount }) => ({ pubkey, amount: util.bcstr(amount) }))
    ]));
}

function stakeSnapshotStrings(util, snapshot){
    return {
        stakeByPubkeyTick: amountStrings(util, snapshot.stakeByPubkeyTick),
        totalByTick: amountStrings(util, snapshot.totalByTick),
        stakersByTick: stakerStrings(util, snapshot.stakersByTick)
    };
}

module.exports = { stakeSnapshotStrings };
