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
 * NODEPROOF verdict settlement: the verification rows a valid verdict writes
 * for its PASS list. Called by ../nodeproof.js only once the verdict is valid.
 *
 ********************************************************************/

// Record one verification row per PASS pubkey that actually holds the
// full_node capability at the set-resolution block (a verdict can't verify a
// non-staker). Idempotent on (epoch_height, signing_pubkey).
async function recordVerifications(handler, verdict){
    // One batched capability read for the whole PASS list, same fallback rule
    // as eligibleVerifierSet: a truncated read re-probes per pubkey. Resolves
    // at the buried setBlock, the height the hub locked its claimant universe
    // at, and the row's source is resolved at that same height (the two must
    // agree: a gate that admits a node whose source resolution then finds no
    // active stake drops the row just as silently as a raw-epoch gate does).
    let setBlock = verdict.setBlock;
    let capRows = await handler.indexerDb.getValidatorsByCapability('full_node', setBlock);
    let capSet  = (capRows && capRows.truncated === true)
                ? null
                : new Set((capRows || []).map(v => String(v.pubkey).toLowerCase()));
    for(let pk of verdict.passList){
        if(capSet ? !capSet.has(pk) : !await handler.indexerDb.hasCapability(pk, 'full_node', setBlock))
            continue;
        await handler.indexerDb.createNodeProofVerification(
            pk, verdict.challengeId, verdict.epochHeight, verdict.targetHeight,
            verdict.actionIndex, verdict.blockIndex, setBlock
        );
    }
}

module.exports = { recordVerifications };
