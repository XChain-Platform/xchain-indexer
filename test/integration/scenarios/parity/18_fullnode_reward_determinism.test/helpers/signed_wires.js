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
 * test/integration/scenarios/parity/18_fullnode_reward_determinism.test/helpers/signed_wires.js
 *
 * The signed wire builders of the full-node reward determinism scenario
 * (18_fullnode_reward_determinism.test.js): Ed25519 identities, NODEPROOF v0 verdicts and
 * PRICE batch actions, each built exactly as the indexer reconstructs and verifies it.
 */

'use strict';

const crypto  = require('crypto');
const ed25519 = require('../../../../../../src/consensus/ed25519.js');
const eq      = require('../../../../../../src/consensus/equivocation_header.js');

const NETWORK = 'regtest';
const DEPTH     = 2;                  // FULLNODE_CONFIRM_DEPTH

// Deterministic Ed25519 identity: { privateKey (KeyObject), pub (raw 64-hex, lowercase) }.
function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pub: Buffer.from(der.slice(-32)).toString('hex').toLowerCase() };
}
const signHex = (priv, buf) => crypto.sign(null, buf, priv).toString('hex');

// Build a NODEPROOF v0 wire action for `epoch`, signed by the genesis verifiers, exactly
// as nodeproof.js reconstructs + verifies it. challenge_id binds to the epoch's stored
// ledger hash (passed in), so the corpus is a function of earlier on-chain state.
function buildNodeproofWire(epoch, ledgerHash, passKeys, verifiers) {
    const target      = epoch - DEPTH;
    const preimage    = NETWORK + ':' + epoch + ':' + String(ledgerHash) + ':' + target;
    const challengeId = crypto.createHash('sha256').update(preimage).digest('hex');
    const passSorted  = passKeys.map(p => p.pub.toLowerCase()).sort();

    let canonRaw = challengeId + '|' + epoch + '|' + passSorted.join(',');
    if (eq.isEquivHeaderActive(epoch, NETWORK))
        canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.NODEPROOF, challengeId, 0, canonRaw);
    const canonical = Buffer.from(canonRaw, 'utf8');

    const sigFields = [];
    for (const v of verifiers) { sigFields.push(v.pub, signHex(v.privateKey, canonical)); }

    return ['NODEPROOF', '0', challengeId, String(epoch),
            String(passSorted.length), ...passSorted,
            String(verifiers.length), ...sigFields].join('|');
}

// Build a signed PRICE batch wire action (version 0) carrying a single round body, over
// the canonical buildPriceBatchPayload applies (it wraps the ORACLE_BATCH equiv header
// itself, unconditionally, unlike the retired per-round builder's height gate).
// Wire: PRICE|0|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|
//         ROUND|TIMESTAMP|ANCHOR_HEIGHT|PAIR_COUNT|pair|price|...  |SIG_COUNT|PUBKEY|SIG|...
//
// One round is enough: the window bounds collapse to that round and its anchor equals the
// header anchor, which is what the parser requires and what keeps the batch off both
// straddle rules. A wider window would exercise batching, not the reward rule under test.
//
// NETWORK is passed as the fifth argument because it is half the mirror admission
// activation key: an absent fifth argument reads as the inert network and rebuilds the
// LEGACY canonical, so an admission-era round would be signed over bytes the indexer never
// reconstructs and the scenario would red on a signature it built itself.
function buildPriceBatchWire(round, timestamp, pairs, signers, btcHeight) {
    const rounds  = [{ round: round, timestamp: timestamp, btcBlockHeight: btcHeight, pairs: pairs }];
    const payload = Buffer.from(ed25519.buildPriceBatchPayload(round, round, btcHeight, rounds, NETWORK), 'utf8');
    const pairFields = [];
    for (const p of pairs) pairFields.push(p.pair, p.price);
    const sigFields = [];
    for (const s of signers) { sigFields.push(s.pub, signHex(s.privateKey, payload)); }
    return ['PRICE', '0', String(round), String(round), String(btcHeight), '1',
            String(round), String(timestamp), String(btcHeight),
            String(pairs.length), ...pairFields,
            String(signers.length), ...sigFields].join('|');
}

module.exports = { genKey, buildNodeproofWire, buildPriceBatchWire };
