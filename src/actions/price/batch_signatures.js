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
 * PRICE v0, phase 4: SIGNATURE VERIFICATION over the batch canonical, then the
 * count-or-stake quorum. Called by the handler only after the structural checks
 * and the straddle rule have passed (v0.js), so every input here is known good.
 *
 ********************************************************************/

const ed25519       = require('../../consensus/ed25519.js');
const swq           = require('../../consensus/stake_weighted_quorum.js');
// The verify-first tally rule is a registry row read by literal key (W5), on the
// batch's BTC anchor height.
const gateRegistry  = require('../../consensus/gate_registry');
const PRICE_SIG_TALLY_KEY = 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION';

// The `price` capability set at the batch anchor, or null when the read
// truncated and every signer must be probed one at a time.
async function resolveCapableSet(indexerDb, btcBlockHeight){
    // Capability set resolved exactly as parseV0 resolves it, at the BATCH's signed BTC
    // anchor and not this action's own BLOCK_INDEX (capability_snapshots.snapshot_block is
    // a BTC height, so off BTC a landing-chain height matches nothing). Includes the same
    // truncation fallback to the per-signer path: getValidatorsByCapability caps at
    // VALIDATOR_QUERY_LIMIT and hasCapability does not, so treating a TRUNCATED read as
    // the whole set would silently drop a qualified signer and under-count the quorum.
    let capableRows = await indexerDb.getValidatorsByCapability('price', btcBlockHeight);
    let capableSet  = (capableRows && capableRows.truncated === true)
                    ? null
                    : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
    return capableSet;
}

// 4. SIGNATURE VERIFICATION over the batch canonical.
async function tallyQualifiedSigners(indexerDb, payload, sigs, btcBlockHeight, verifyFirst, capableSet){
    let validSigs = 0;
    let qualifiedSigners = [];
    let seenPubkey = new Set();
    let capabilityCache = new Map();
    for(let s of sigs){
        if(seenPubkey.has(s.pubkey)){
            // Duplicate pubkey signature: count only once
            continue;
        }
        if(!verifyFirst) seenPubkey.add(s.pubkey);

        // Verify the validator's stake qualifies for the `price` capability at this block
        let capable;
        if(capableSet){
            capable = capableSet.has(s.pubkey);
        } else {
            capable = capabilityCache.get(s.pubkey);
            if(capable === undefined){
                capable = await indexerDb.hasCapability(s.pubkey, 'price', btcBlockHeight);
                capabilityCache.set(s.pubkey, capable);
            }
        }
        if(!capable){
            continue;
        }

        // Verify the signature
        if(!ed25519.verify(payload, s.sig, s.pubkey))
            continue;

        if(verifyFirst) seenPubkey.add(s.pubkey);
        validSigs++;
        qualifiedSigners.push(s.pubkey);
    }
    return { validSigs: validSigs, qualifiedSigners: qualifiedSigners };
}

// Count-or-stake quorum. Returns the error, or null when the batch clears it.
async function checkBatchQuorum(indexerDb, config, btcBlockHeight, validSigs, qualifiedSigners){
    // Count-or-stake quorum. The GATE, the WEIGHTS and the capability count all key on the
    // batch's signed BTC anchor, exactly as parseV0 keys them: the gate must flip on one
    // height for every chain and the hub, and the validator set is BTC-anchored because
    // capability staking is BTC-only.
    let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, config['NETWORK']);
    if(weighted){
        let validators = await indexerDb.getStakeWeightsByCapability('price', btcBlockHeight);
        if(!swq.meetsStakeThreshold(validators, qualifiedSigners))
            return 'invalid: insufficient signer stake';
    } else {
        let priceValidatorCount = await indexerDb.getActiveCapabilityCount('price', btcBlockHeight);
        let quorum = (priceValidatorCount <= 1) ? 1 : Math.max(2 * Math.floor((priceValidatorCount - 1) / 3) + 1, Math.ceil((priceValidatorCount + 1) / 2));

        if(validSigs < quorum)
            return 'invalid: insufficient PBFT quorum (' + validSigs + '/' + quorum + ')';
    }
    return null;
}

// Verify the batch signatures, then hold the qualified set to the quorum rule.
async function verifyBatchSignatures(indexerDb, config, batch){
    // buildPriceBatchPayload is the ONLY canonical builder; the hub's two twins are
    // byte-identical to it. Never inline the JSON here, or the three copies drift and
    // every honest batch fails.
    let payload = ed25519.buildPriceBatchPayload(batch.firstRound, batch.lastRound,
        batch.btcBlockHeight, batch.rounds, config['NETWORK']);
    // PRICE_SIG_TALLY, keyed on the BATCH anchor because a batch resolves the gate once
    // (the straddle rule above is what makes that one resolution sound for every round in
    // the window). At/above the gate a pubkey enters the dedupe set only after a
    // successful verify, so a garbage signature carrying a qualified oracle's pubkey
    // cannot be ordered ahead of that oracle's real one to consume its slot.
    let verifyFirst = gateRegistry.activeAt(PRICE_SIG_TALLY_KEY, config['NETWORK'], null,
        batch.btcBlockHeight, null);
    let capableSet = await resolveCapableSet(indexerDb, batch.btcBlockHeight);
    let tally = await tallyQualifiedSigners(indexerDb, payload, batch.sigs,
        batch.btcBlockHeight, verifyFirst, capableSet);
    return await checkBatchQuorum(indexerDb, config, batch.btcBlockHeight,
        tally.validSigs, tally.qualifiedSigners);
}

module.exports = { verifyBatchSignatures, resolveCapableSet, tallyQualifiedSigners, checkBatchQuorum };
