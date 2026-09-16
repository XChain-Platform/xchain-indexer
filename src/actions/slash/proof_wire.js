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
 * SLASH wire reading: turning the seven pipe-delimited parameters into the proof
 * the rest of the handler reasons about, and deciding which membership the
 * engine's equivocation is judged against.
 *
 * Everything here is a pure read of the submitted bytes: no chain state, no
 * signature checks, no ledger. It is separated from the handler because these
 * are the rules about what the WIRE says (field presence, the EQUIV header and
 * key boundary, the engine's capability label), while the handler decides what
 * the chain says about it.
 *
 ********************************************************************/

const eq = require('../../consensus/equivocation_header.js');


// ENGINE_TAG → the membership label the locked snapshot governs that engine's signer
// set under. For the five capability-scoped engines this is the staking capability whose
// MIN_STAKE-qualified set signed the slot. XCONFIG is the exception: config-change PBFT is
// authorized by the WHOLE federation (every active staker, no capability subset; see
// xchain-hub Consensus._lockSnapshot), so it carries the sentinel label 'config' and its
// membership resolves against getActiveValidators (handled in parse()), not a capability set.
const CONFIG_CAPABILITY = 'config';
const ENGINE_CAPABILITY = {
    [eq.ENGINE_TAGS.DEX]:        'cross_chain',
    [eq.ENGINE_TAGS.XCALL]:      'cross_chain',
    [eq.ENGINE_TAGS.CHECKPOINT]: 'oracle_publish',
    [eq.ENGINE_TAGS.ORACLE]:     'price',
    // PRICE batches are signed by the same price-capable set as v0 rounds, under the
    // same locked snapshot, so they burn the same bond. The tag is distinct only so a v0
    // round and a batch at one BTC anchor can never share an equiv key.
    [eq.ENGINE_TAGS.ORACLE_BATCH]: 'price',
    [eq.ENGINE_TAGS.ATTEST]:     'attestation',
    // The bridge and the token-policy engines are signed by the SAME cross_chain set the DEX
    // and XCALL are, under the same locked snapshot, so they burn the same bond. They are in
    // this map because a forgery in either DIRECTS VALUE: an XBRIDGE canonical mints units on
    // a destination chain, and an XPOLICY canonical decides who may move a bridged row's
    // units at all. A tag absent from this map is namespacing only and is NOT a slashable
    // family (XNODEPROOF and ROLLCALL are deliberately absent for that reason), which for
    // these two would leave the one class of equivocation that moves money unpunished.
    // Distinct tags, so a validator that signs one transfer and one policy snapshot in the
    // same round can never collide on an equivocation key.
    [eq.ENGINE_TAGS.BRIDGE]:     'cross_chain',
    [eq.ENGINE_TAGS.POLICY]:     'cross_chain',
    [eq.ENGINE_TAGS.CONFIG]:     CONFIG_CAPABILITY,
};

// Read and shape-check the seven wire fields. `data` is written exactly as the
// handler wrote it inline: CAPABILITY and OFFENDER_PUBKEY land on it whether or
// not the action is valid, because a rejected SLASH still stores what it claimed.
function readProofWire(formats, util, params, data, error){
    // Validate format
    let format = data['FORMAT'];
    if(!error && (format === null || formats[format] === undefined))
        error = 'invalid: VERSION (unknown)';

    // Extract fields
    data['CAPABILITY']      = params[1];
    data['OFFENDER_PUBKEY'] = params[2];
    let msgAb64 = params[3], sigA = params[4], msgBb64 = params[5], sigB = params[6];

    // SLASH is BTC-only (capability stake is BTC-only)
    if(!error && data['COIN'] !== 'BTC')
        error = 'invalid: ACTION (BTC only)';

    // Field presence
    if(!error && (util.isNull(data['OFFENDER_PUBKEY']) ||
                  util.isNull(msgAb64) || util.isNull(sigA) ||
                  util.isNull(msgBb64) || util.isNull(sigB) || util.isNull(data['CAPABILITY'])))
        error = 'invalid: missing field';

    // OFFENDER_PUBKEY format
    let offender = String(data['OFFENDER_PUBKEY'] || '').toLowerCase();
    if(!error && !/^[0-9a-fA-F]{64}$/.test(offender))
        error = 'invalid: OFFENDER_PUBKEY (format)';

    // Decode the two signed canonicals (base64url → utf8 string)
    let msgA = null, msgB = null;
    if(!error){
        try { msgA = Buffer.from(String(msgAb64), 'base64url').toString('utf8'); } catch(e){ msgA = null; }
        try { msgB = Buffer.from(String(msgBb64), 'base64url').toString('utf8'); } catch(e){ msgB = null; }
        if(msgA === null || msgB === null) error = 'invalid: MSG (base64)';
    }
    return { error: error, offender: offender, msgA: msgA, msgB: msgB, sigA: sigA, sigB: sigB };
}

// Derive the EQUIV key from MSG_A and split it into (engineTag, roundId, view).
// The wire never carries the key, so this is the only place it exists.
function deriveEquivKey(msgA, msgB, error){
    // (1) Derive the EQUIV key from MSG_A's header. The wire action does NOT carry it
    // (it contains '|' and would break the pipe split). The header is
    // `EQUIV|<ENGINE_TAG|ROUND_ID|VIEW>||<CONTENT>`; the key has no `||` (no empty
    // segment), so the FIRST `||` is the unambiguous key/content boundary.
    let equivKey = '', prefix = '';
    if(!error){
        let sep = msgA.startsWith('EQUIV|') ? msgA.indexOf('||') : -1;
        if(sep < 0){
            error = 'invalid: MSG_A has no EQUIV header';
        } else {
            prefix   = msgA.slice(0, sep + 2);            // 'EQUIV|<key>||'
            equivKey = msgA.slice('EQUIV|'.length, sep);  // '<key>'
        }
    }

    // Both messages must share that EXACT header prefix (same engine, round, AND view).
    if(!error && !msgB.startsWith(prefix))
        error = 'invalid: EQUIV header/key mismatch';

    // (2) Their content must DIFFER (identical bytes = the same message, not equivocation).
    if(!error && msgA === msgB)
        error = 'invalid: identical messages (not equivocation)';

    // Parse the key into (engineTag, roundId, view). ROUND_ID may contain '|',
    // so take the FIRST segment as the tag and the LAST as the view.
    let engineTag = '', roundId = '', view = '';
    if(!error){
        let firstPipe = equivKey.indexOf('|');
        let lastPipe  = equivKey.lastIndexOf('|');
        if(firstPipe < 0 || lastPipe <= firstPipe){
            error = 'invalid: EQUIV_KEY (format)';
        } else {
            engineTag = equivKey.substring(0, firstPipe);
            view      = equivKey.substring(lastPipe + 1);
            roundId   = equivKey.substring(firstPipe + 1, lastPipe);
        }
    }
    return { error: error, equivKey: equivKey, prefix: prefix, engineTag: engineTag, roundId: roundId, view: view };
}

// The capability whose locked snapshot governs this engine, derived from the tag.
function capabilityForEngine(engineTag, error){
    // CAPABILITY must be the one the engine maps to (derived, not trusted). XCONFIG
    // maps to the sentinel 'config' capability (membership resolves
    // against getActiveValidators, see below). Only an unknown/unmapped engine has no
    // slashable membership here → reject.
    let capability = null;
    if(!error){
        capability = ENGINE_CAPABILITY[engineTag];
        if(!capability)
            error = 'invalid: ENGINE_TAG (not slashable)';
    }
    return { error: error, capability: capability };
}

module.exports = { CONFIG_CAPABILITY, ENGINE_CAPABILITY, readProofWire, deriveEquivKey, capabilityForEngine };
