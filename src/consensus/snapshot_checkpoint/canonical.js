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
 *********************************************************************/

'use strict';

const srb = require('../snapshot_reorg_buffer.js');
const swq = require('../stake_weighted_quorum.js');

const SNAPSHOT_CHECKPOINT_TAG = 'XSNAPCKPT';
const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const WEIGHT = /^\+?(?:\d+\.?\d*|\.\d+)$/;

function snapshotCheckpointBlock(snapshotBlock, network) {
    return srb.buriedSnapshotBlock(snapshotBlock, network);
}

function snapshotCheckpointCanonical(cp) {
    if (!cp || cp.chain !== 'BTC')
        throw new Error('snapshot checkpoint chain must be BTC');
    if (!Number.isSafeInteger(cp.block_index))
        throw new Error('snapshot checkpoint block_index must be a safe integer');
    if (!HEX_64.test(cp.block_hash) || !HEX_64.test(cp.state_root))
        throw new Error('snapshot checkpoint hashes must be 64-hex');

    return [
        SNAPSHOT_CHECKPOINT_TAG,
        cp.chain,
        cp.network,
        String(cp.block_index),
        cp.block_hash.toLowerCase(),
        cp.state_root.toLowerCase(),
        String(cp.state_root_version),
    ].join('|');
}

function snapshotCheckpointRoundId(cp) {
    return ['SNAP', cp.chain, cp.network, String(cp.block_index)].join('|');
}

function validTrustSet(trustSet) {
    if (!Array.isArray(trustSet) || trustSet.length === 0 || trustSet.truncated === true)
        return false;

    const pubkeys = new Set();
    for (const validator of trustSet) {
        if (!validator || !HEX_64.test(validator.pubkey)) return false;
        if (validator.source === null || validator.source === undefined || String(validator.source).trim() === '')
            return false;
        if (validator.weight === null || validator.weight === undefined || !WEIGHT.test(String(validator.weight).trim()))
            return false;
        const pubkey = validator.pubkey.toLowerCase();
        if (pubkeys.has(pubkey)) return false;
        pubkeys.add(pubkey);
    }
    return true;
}

function signatureRows(value) {
    if (typeof value !== 'string') return Array.isArray(value) ? value : null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

function snapshotCheckpointQuorum(cp, trustSet, verify) {
    if (!validTrustSet(trustSet) || typeof verify !== 'function') return false;
    const signatures = signatureRows(cp && cp.validator_signatures);
    if (signatures === null) return false;

    const trusted = new Set(trustSet.map((validator) => validator.pubkey.toLowerCase()));
    const signers = [];
    const seen = new Set();
    const canonical = snapshotCheckpointCanonical(cp);

    for (const row of signatures) {
        if (!row || !HEX_64.test(row.pubkey) || !HEX_128.test(row.sig)) continue;
        const pubkey = row.pubkey.toLowerCase();
        if (!trusted.has(pubkey) || seen.has(pubkey)) continue;

        let verified = false;
        try {
            verified = verify(canonical, row.sig, row.pubkey) === true;
        } catch (e) {
            verified = false;
        }
        if (!verified) continue;

        seen.add(pubkey);
        signers.push(pubkey);
    }

    return swq.meetsStakeThreshold(trustSet, signers);
}

module.exports = {
    SNAPSHOT_CHECKPOINT_TAG,
    snapshotCheckpointBlock,
    snapshotCheckpointCanonical,
    snapshotCheckpointRoundId,
    snapshotCheckpointQuorum,
};
