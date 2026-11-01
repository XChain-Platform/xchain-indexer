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
 * Every distinct copy of a mirrored anchor reward tuple.
 *
 * anchor_reward_attestations keeps the first copy of each reward tuple it receives (INSERT
 * IGNORE on uq_reward_tuple), and the copy's doge_anchor_txid and publisher_attestations are
 * outside the signed XANCPUB canonical, so which copy a node keeps depends on arrival order.
 * applyRow also hands each applied row here, which records it in
 * anchor_reward_attestation_copies keyed by the tuple plus copyDigest, so the node holds
 * every copy it has received. The BTC derive pass reads them from
 * ANCHOR_REWARD_COPY_SELECTION_ACTIVATION (src/sql/anchor_reward_attestation_copies.sql).
 *
 * A consumer whose schema has no copies table (a vendored mirror without the SQL file)
 * skips the write. A BTC indexer fails the row apply instead because copy completeness
 * decides anchor-reward derivation there.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { applyMirrorWrite } = require('../mirror_write.js');
const { mirrorTablePresent } = require('../barriers/mirror_table_probe.js');
const { getLogger } = require('../../../observability/index.js');

const COPIES_TABLE = 'anchor_reward_attestation_copies';
const COPY_COLUMNS = ['chain', 'network', 'reward_type', 'round_reference', 'snapshot_block', 'publisher',
                      'publisher_attestations', 'doge_anchor_txid', 'copy_digest'];

// The identity of one copy within its tuple: sha256 over the two unsigned fields, the
// txid ('' when absent) and the attestation list text, joined by '|'. Lowercase hex.
function copyDigest(row){
    const txid = (row.doge_anchor_txid === null || row.doge_anchor_txid === undefined) ? '' : String(row.doge_anchor_txid);
    const sigs = (row.publisher_attestations === null || row.publisher_attestations === undefined) ? '' : String(row.publisher_attestations);
    return crypto.createHash('sha256').update(txid + '|' + sigs, 'utf8').digest('hex');
}

// The INSERT IGNORE that records one copy, and its arguments, for a row as the hub serves it.
function copyInsert(row){
    const values = Object.assign({}, row, { copy_digest: copyDigest(row) });
    const args = COPY_COLUMNS.map((c) => (values[c] === undefined ? null : values[c]));
    const sql = 'INSERT IGNORE INTO ' + COPIES_TABLE + ' (' + COPY_COLUMNS.join(', ') + ') VALUES (' +
                COPY_COLUMNS.map(() => '?').join(', ') + ')';
    return { sql, args };
}

// Per-instance copy-write state on the HubDbSync instance: the error texts already logged and
// the failure count mirrorStatus reports.
function copyState(sync){
    if(!sync._attestationCopies) sync._attestationCopies = { warned: new Set(), failures: 0 };
    return sync._attestationCopies;
}

// The explorer vendors this client but has no indexer back-reference. Only a BTC indexer
// derives anchor rewards from the copy set and therefore needs copy writes to fail closed.
function isDerivingAnchorRewardNode(sync){
    const indexer = sync && sync.hubDb && sync.hubDb.indexer;
    return String(sync && sync.coin || '').trim().toUpperCase() === 'BTC' &&
        !!(indexer && indexer.indexerDb);
}

// Record `row`, an anchor_reward_attestations row applyRow has just applied, as a copy.
// A missing table or failed write rejects the apply on a BTC indexer, keeping the drain cursor
// before the row so its idempotent main upsert and copy insert can retry. Other consumers keep
// best-effort behavior. Failed writes are counted and logged once per distinct error.
async function recordAttestationCopy(sync, row){
    const state = copyState(sync);
    const deriving = isDerivingAnchorRewardNode(sync);
    if(!await mirrorTablePresent(sync, COPIES_TABLE)){
        if(deriving) throw new Error(COPIES_TABLE + ' is required for BTC anchor-reward derivation');
        return false;
    }
    try {
        const { sql, args } = copyInsert(row);
        await applyMirrorWrite(sync.hubDb, sql, args);
        return true;
    } catch (e) {
        state.failures++;
        const text = String(e && e.message ? e.message : e);
        if(!state.warned.has(text)){
            state.warned.add(text);
            getLogger().warn('HubDbSync: ' + COPIES_TABLE + ' write failed (' + text + ')' +
                (deriving ? '; the BTC mirror row will retry' : '; only this copy is not recorded'));
        }
        if(deriving) throw e;
        return false;
    }
}

module.exports = { COPIES_TABLE, copyDigest, copyInsert, isDerivingAnchorRewardNode, recordAttestationCopy };
