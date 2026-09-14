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
 * SLASH payout policy: how a burned bond is divided between the submitter's
 * bounty and the governance treasury.
 *
 * It is a pure function of config and the burned total, with no chain reads and
 * no ledger writes, which is why it sits apart from the handler that applies the
 * result: the clamp order here (floor, then cap, then never more than the bond)
 * is the whole policy, and it is worth reading without the settlement around it.
 *
 ********************************************************************/

// Bounty/treasury split for a burned bond. Governance-configured. The submitter's
// bounty = clamp(BOUNTY_BPS·burned, BOUNTY_FLOOR, BOUNTY_CAP), never exceeding the bond; the
// remainder goes to TREASURY_ADDRESS, or is BURNED when unset. Config shape:
//   config.STAKING.CAPABILITIES[capability].SLASH  for the 5 capability-scoped engines, or
//   config.CONFIG_SLASH                            for XCONFIG (capability === 'config',
//                                                  whole-federation scope, no CAPABILITIES home)
//   = { BOUNTY_BPS, BOUNTY_FLOOR, BOUNTY_CAP, TREASURY_ADDRESS }  (all optional)
// Absent / zero → PURE BURN (bounty 0, no treasury credit). Never pays validators.
function bountyTreasurySplit(config, util, capability, burned){
    let total = String(burned || '0');
    if(!util.bcgt(total, '0')) return { bounty: '0', treasury: '0', treasuryAddr: null };

    // XCONFIG has no staking capability, so its SLASH policy lives at config.CONFIG_SLASH;
    // every other engine reads its capability's SLASH block.
    let cfg;
    if(capability === 'config'){
        cfg = config['CONFIG_SLASH'] || {};
    } else {
        let caps = (config['STAKING'] && config['STAKING']['CAPABILITIES']) ? config['STAKING']['CAPABILITIES'] : {};
        cfg = (caps[capability] && caps[capability]['SLASH']) ? caps[capability]['SLASH'] : {};
    }

    let bps = Number(cfg['BOUNTY_BPS'] || 0);
    if(!Number.isFinite(bps) || bps < 0) bps = 0;
    if(bps > 10000) bps = 10000;

    // bc* return mathjs BigNumbers → String() so the ledger sees plain amount strings
    // (the convention everywhere else, e.g. STAKE's debits).
    let bounty = (bps > 0)
        ? String(util.bcdiv(util.bcmul(total, String(bps), 8), '10000', 8))
        : '0';
    // FLOOR: guarantee a minimum payout so a submitter always clears the (BTC-tx + protocol)
    // submission cost, even on a bond at MIN_STAKE. Applied before the cap; the final clamp
    // to `total` keeps a sub-floor bond from minting (bounty = whole bond, treasury 0).
    let floor = cfg['BOUNTY_FLOOR'];
    if(floor != null && util.bcgt(String(floor), bounty))
        bounty = String(floor);
    // CAP: hard ceiling (detection cost is constant; don't scale the reward with whale bonds).
    let cap = cfg['BOUNTY_CAP'];
    if(cap != null && util.bcgt(bounty, String(cap)))
        bounty = String(cap);
    // Never pay out more than was burned.
    if(util.bcgt(bounty, total))
        bounty = total;

    let treasury     = String(util.bcsub(total, bounty, 8));
    let treasuryAddr = cfg['TREASURY_ADDRESS'] ? String(cfg['TREASURY_ADDRESS']) : null;  // null = BURN
    return { bounty: bounty, treasury: treasury, treasuryAddr: treasuryAddr };
}

module.exports = { bountyTreasurySplit };
